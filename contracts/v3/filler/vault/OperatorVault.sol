// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IOperatorVault } from "./interfaces/IOperatorVault.sol";
import { IOperatorVaultFactory } from "./interfaces/IOperatorVaultFactory.sol";
import { IYieldAdapter } from "./interfaces/IYieldAdapter.sol";
import { VaultErrors } from "./libraries/VaultErrors.sol";
import { VaultLib } from "./libraries/VaultLib.sol";
import { VaultPolicy } from "./libraries/VaultPolicy.sol";
import { VaultTypes } from "./libraries/VaultTypes.sol";

/**
 * @title OperatorVault
 * @notice Immutable two-asset RFQ maker vault. LPs hold ERC-20 shares. The
 *         operator only signs constrained LimitOrders; Permit2 cannot move
 *         tokens without a vault-validated ERC-1271 envelope. Deposits and
 *         redemptions settle in aggregate epochs. One closed redemption at a
 *         time; pause is an orthogonal flag over derived close-only mode.
 */
contract OperatorVault is ERC20, ReentrancyGuard, IERC1271, IOperatorVault, VaultErrors {
  using SafeERC20 for IERC20;

  enum EpochState {
    None,
    Open,
    Closed,
    Processed,
    Voided,
    Settled
  }

  struct Epoch {
    EpochState state;
    bool isDeposit;
    uint64 openedAt;
    uint64 cutoff;
    uint64 closedAt;
    uint256 assets;
    uint256 shares;
    uint256 remainingUnits;
    uint256 remainingSettlement;
    uint256 remainingCorridor;
    /// @dev In-kind yield claim, in scaled units. See `outstandingYieldWeight`.
    uint256 remainingYield;
  }

  IERC20 public immutable override settlementAsset;
  IERC20 public immutable override corridorAsset;
  address public immutable factory;
  address public immutable reactor;
  address public immutable permit2;
  address public immutable preferredFillerValidation;
  uint256 public immutable version;
  uint256 public immutable maxOrderInputSettlement;
  uint256 public immutable maxOrderInputCorridor;
  uint256 public immutable minReserveSettlement;
  uint256 public immutable minReserveCorridor;
  uint256 public immutable maxOrderLifetime;
  uint256 public immutable depositEpochDuration;
  uint256 public immutable redemptionEpochDuration;
  uint256 public immutable redemptionCloseCooldown;
  uint256 public immutable inKindExitTimeout;
  uint256 public immutable emergencyExitTimeout;
  uint256 public immutable valuationTimeout;
  uint256 public immutable managementFeeWad;
  uint256 public immutable riskSignerDelay;
  uint256 public immutable minDepositAssets;
  uint256 public immutable minRedeemShares;
  uint8 public immutable settlementDecimals;
  uint8 public immutable corridorDecimals;
  /// @notice Optional idle-yield adapter for the settlement asset. Zero = off.
  IYieldAdapter public immutable yieldAdapter;
  /// @notice Liquid settlement floor `allocateIdle` never supplies below.
  uint256 public immutable minLiquidSettlement;
  /// @notice Token the adapter position is held in (e.g. the aToken). Zero
  ///         when yield is off. Paid out in kind by the emergency exit when
  ///         the underlying cannot be recalled. Not public: the auto-getter
  ///         costs more bytecode than this contract has to spare, and the
  ///         value is `yieldAdapter().yieldToken()` off-chain.
  address internal immutable yieldToken;

  VaultTypes.Roles private _roles;

  bool public override paused;
  uint256 public override tradingEpoch;
  uint256 public nextEpochId;
  uint256 public currentDepositEpochId;
  uint256 public currentRedeemEpochId;
  uint256 public closedRedeemEpochId;
  uint256 public lastFeeCheckpoint;
  uint256 public lastSettledNav;
  uint256 public lastRedeemSettledAt;
  uint256 public pendingSettlement;
  uint256 public reservedSettlement;
  uint256 public reservedCorridor;
  /// @notice Sum of the unclaimed `Epoch.remainingYield` weights. The in-kind
  ///         yield leg is a weight, not an amount: claims split the vault's
  ///         live yield-token balance by weight, so interest that accrues
  ///         between an emergency settle and the last claim follows the claim
  ///         and the last claimant out sweeps the residue. Weights are
  ///         denominated in the adapter's index-invariant scaled units
  ///         (`IYieldAdapter.toScaled`), so two epochs that settled at
  ///         different liquidity indices still split the pot by what each is
  ///         actually owed rather than by stale face values.
  uint256 internal outstandingYieldWeight;
  /// @notice Position an emergency exit owes redeemers but could not move out
  ///         of the adapter yet. Aave blocks aToken transfers on a paused
  ///         reserve exactly like it blocks withdrawals, so settlement books
  ///         the claim and the tokens cross on the first adapter touch that
  ///         works. Excluded from NAV until then.
  ///
  ///         Scaled, like `outstandingYieldWeight`, because the slice keeps
  ///         rebasing inside the adapter. Read it through `_owedAssets`.
  uint256 internal pendingYieldPull;

  mapping(uint256 => Epoch) public epochs;
  mapping(address => mapping(uint256 => uint256)) public requestUnits;
  mapping(address => mapping(uint256 => bool)) public requestClaimed;
  mapping(address => mapping(address => bool)) public isOperator;

  event DepositRequest(
    address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 assets
  );
  event DepositCancelled(address indexed controller, uint256 indexed epochId, uint256 assets);
  event RedeemRequest(
    address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares
  );
  event EpochClosed(uint256 indexed epochId, bool isDeposit, uint256 units);
  event DepositEpochProcessed(uint256 indexed epochId, uint256 assets, uint256 shares, uint256 price);
  event DepositEpochVoided(uint256 indexed epochId);
  event RedeemEpochSettled(
    uint256 indexed epochId, bool inKind, uint256 shares, uint256 settlementOut, uint256 corridorOut
  );
  event RedeemYieldSettled(uint256 indexed epochId, uint256 yieldOut);
  event Claimed(
    address indexed controller,
    address indexed receiver,
    uint256 indexed epochId,
    uint256 sharesOut,
    uint256 settlementOut,
    uint256 corridorOut
  );

  modifier onlyOperatorAdmin() {
    if (msg.sender != _roles.operatorAdmin) revert VaultErrors.NotAuthorized();
    _;
  }

  modifier onlyRiskAdmin() {
    if (msg.sender != _roles.riskAdmin) revert VaultErrors.NotAuthorized();
    _;
  }

  modifier onlyGuardian() {
    if (msg.sender != _roles.guardian) revert VaultErrors.NotAuthorized();
    _;
  }

  constructor(VaultTypes.VaultConfig memory cfg) ERC20("Textile Operator Vault", "tOV") {
    (settlementDecimals, corridorDecimals) = VaultPolicy.validateConfig(cfg);

    settlementAsset = cfg.settlementAsset;
    corridorAsset = cfg.corridorAsset;
    factory = msg.sender;
    reactor = cfg.reactor;
    permit2 = cfg.permit2;
    preferredFillerValidation = cfg.preferredFillerValidation;
    version = cfg.version;
    maxOrderInputSettlement = cfg.maxOrderInputSettlement;
    maxOrderInputCorridor = cfg.maxOrderInputCorridor;
    minReserveSettlement = cfg.minReserveSettlement;
    minReserveCorridor = cfg.minReserveCorridor;
    maxOrderLifetime = cfg.maxOrderLifetime;
    depositEpochDuration = cfg.depositEpochDuration;
    redemptionEpochDuration = cfg.redemptionEpochDuration;
    redemptionCloseCooldown = cfg.redemptionCloseCooldown;
    inKindExitTimeout = cfg.inKindExitTimeout;
    emergencyExitTimeout = cfg.emergencyExitTimeout;
    valuationTimeout = cfg.valuationTimeout;
    managementFeeWad = cfg.managementFeeWad;
    riskSignerDelay = cfg.riskSignerDelay;
    minDepositAssets = cfg.minDepositAssets;
    minRedeemShares = cfg.minRedeemShares;
    yieldAdapter = IYieldAdapter(cfg.yieldAdapter);
    minLiquidSettlement = cfg.minLiquidSettlement;

    _roles.operatorAdmin = cfg.operatorAdmin;
    _roles.strategySigner = cfg.strategySigner;
    _roles.riskAdmin = cfg.riskAdmin;
    _roles.riskSigner = cfg.riskSigner;
    _roles.guardian = cfg.guardian;
    _roles.feeRecipient = cfg.feeRecipient;

    tradingEpoch = 1;
    nextEpochId = 1;
    lastFeeCheckpoint = block.timestamp;

    cfg.settlementAsset.forceApprove(cfg.permit2, type(uint256).max);
    cfg.corridorAsset.forceApprove(cfg.permit2, type(uint256).max);

    // Bind the freshly cloned adapter in the same factory tx — no front-run
    // window. Only the settlement asset is ever approved; never the Aave pool.
    yieldToken = cfg.yieldAdapter == address(0)
      ? address(0)
      : VaultPolicy.bindYieldAdapter(cfg.yieldAdapter, cfg.settlementAsset);
  }

  /*//////////////////////////////////////////////////////////////
                              DEPOSITS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IOperatorVault
  function requestDeposit(uint256 assets, address controller, address owner)
    external
    override
    nonReentrant
    returns (uint256 requestId)
  {
    if (paused) revert VaultErrors.EnforcedPause();
    if (assets < minDepositAssets) revert VaultErrors.BelowMinSize();
    if (controller == address(0) || owner == address(0)) revert VaultErrors.ZeroAddress();
    _requireAuthorized(owner);

    requestId = _openOrCurrentDepositEpoch();
    Epoch storage epoch = epochs[requestId];

    _pullExact(settlementAsset, owner, assets);
    pendingSettlement += assets;
    epoch.assets += assets;
    requestUnits[controller][requestId] += assets;

    emit DepositRequest(controller, owner, requestId, msg.sender, assets);
  }

  /// @inheritdoc IOperatorVault
  /// @dev Refunds the controller, not the depositing owner — the ERC-7540
  ///      controller model (the owner authorises, the controller holds the
  ///      request rights). Mind this when wiring `owner != controller`.
  function cancelDeposit(uint256 requestId, address controller) external override nonReentrant {
    Epoch storage epoch = epochs[requestId];
    if (!epoch.isDeposit || epoch.state != EpochState.Open) revert VaultErrors.EpochNotOpen();
    if (block.timestamp >= epoch.cutoff) revert VaultErrors.CancelWindowClosed();
    _requireAuthorized(controller);

    uint256 assets = requestUnits[controller][requestId];
    if (assets == 0) revert VaultErrors.NothingToClaim();

    requestUnits[controller][requestId] = 0;
    epoch.assets -= assets;
    pendingSettlement -= assets;
    settlementAsset.safeTransfer(controller, assets);

    emit DepositCancelled(controller, requestId, assets);
  }

  /// @inheritdoc IOperatorVault
  function closeDepositEpoch(uint256 epochId) external override {
    Epoch storage epoch = epochs[epochId];
    if (!epoch.isDeposit || epoch.state != EpochState.Open) revert VaultErrors.EpochNotOpen();
    if (block.timestamp < epoch.cutoff) revert VaultErrors.EpochNotReady();
    epoch.state = EpochState.Closed;
    epoch.closedAt = uint64(block.timestamp);
    if (currentDepositEpochId == epochId) currentDepositEpochId = 0;
    emit EpochClosed(epochId, true, epoch.assets);
  }

  /// @inheritdoc IOperatorVault
  function processDepositEpoch(
    uint256 epochId,
    VaultLib.NavAttestation calldata attestation,
    bytes calldata signature
  ) external override nonReentrant {
    if (paused) revert VaultErrors.EnforcedPause();
    Epoch storage epoch = _closedEpoch(epochId, true);
    if (epoch.assets == 0) {
      epoch.state = EpochState.Processed;
      emit DepositEpochProcessed(epochId, 0, 0, attestation.corridorAssetPrice);
      return;
    }

    uint256 price = VaultPolicy.verifyAttestation(attestation, signature, epochId, address(this), _roles.riskSigner);
    _checkpointFee();

    uint256 supply = totalSupply();
    (uint256 conversionNav,,) = _requireLiveNav(attestation, price);
    uint256 shares = VaultLib.convertToShares(epoch.assets, supply, conversionNav, Math.Rounding.Floor);
    if (shares == 0) revert VaultErrors.ZeroAmount();

    pendingSettlement -= epoch.assets;
    _mint(address(this), shares);

    epoch.shares = shares;
    epoch.remainingUnits = epoch.assets;
    epoch.state = EpochState.Processed;

    _recordSettledNav(price);
    emit DepositEpochProcessed(epochId, epoch.assets, shares, price);
  }

  /// @inheritdoc IOperatorVault
  /// @dev Races `processDepositEpoch` once `valuationTimeout` elapses:
  ///      whoever lands first wins. Voiding only refunds depositors their own
  ///      settlement, so there is no loss either way — size the timeout
  ///      comfortably past the operator's expected processing window.
  function voidDepositEpoch(uint256 epochId) external override {
    Epoch storage epoch = _closedEpoch(epochId, true);
    _requireElapsed(epoch.closedAt, valuationTimeout);
    epoch.state = EpochState.Voided;
    emit DepositEpochVoided(epochId);
  }

  /*//////////////////////////////////////////////////////////////
                             REDEMPTIONS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IOperatorVault
  /// @dev Deliberately no pause check, unlike `requestDeposit`: exits must
  ///      always be able to queue; only new capital is blocked while paused.
  function requestRedeem(uint256 shares, address controller, address owner)
    external
    override
    nonReentrant
    returns (uint256 requestId)
  {
    if (shares < minRedeemShares) revert VaultErrors.BelowMinSize();
    if (controller == address(0) || owner == address(0)) revert VaultErrors.ZeroAddress();

    requestId = _openOrCurrentRedeemEpoch();
    _pullShares(owner, shares);
    epochs[requestId].assets += shares;
    requestUnits[controller][requestId] += shares;

    emit RedeemRequest(controller, owner, requestId, msg.sender, shares);
  }

  /// @inheritdoc IOperatorVault
  function closeRedeemEpoch(uint256 epochId) external override {
    if (closedRedeemEpochId != 0) revert VaultErrors.RedeemEpochOutstanding();
    Epoch storage epoch = epochs[epochId];
    if (epoch.isDeposit || epoch.state != EpochState.Open) revert VaultErrors.EpochNotOpen();
    if (!_durationElapsed(epoch.openedAt, redemptionEpochDuration)) revert VaultErrors.EpochNotReady();
    if (lastRedeemSettledAt != 0 && !_durationElapsed(lastRedeemSettledAt, redemptionCloseCooldown)) {
      revert VaultErrors.CloseCooldownActive();
    }

    epoch.state = EpochState.Closed;
    epoch.closedAt = uint64(block.timestamp);
    closedRedeemEpochId = epochId;
    if (currentRedeemEpochId == epochId) currentRedeemEpochId = 0;
    _bumpTradingEpoch();
    emit EpochClosed(epochId, false, epoch.assets);
  }

  /// @inheritdoc IOperatorVault
  function settleRedeemEpoch(
    uint256 epochId,
    VaultLib.NavAttestation calldata attestation,
    bytes calldata signature
  ) external override nonReentrant {
    if (paused) revert VaultErrors.EnforcedPause();
    Epoch storage epoch = _closedEpoch(epochId, false);
    (uint256 price, uint256 supply, uint256 conversionNav, uint256 freeS, uint256 freeC) =
      _attestedPrologue(epochId, attestation, signature);
    uint256 settlementOut = VaultLib.convertToAssets(epoch.assets, supply, conversionNav, Math.Rounding.Floor);
    if (settlementOut == 0) revert VaultErrors.ZeroAmount();
    // Cash settlement stays on the attested NAV while ERC-1271 is live.
    // Paying live here would let a filler settle in `executeWithCallback`
    // after the input pull and before the output lands. Leftover on a
    // full-supply exit has to go through pause + in-kind instead.
    if (epoch.assets == supply && (freeS > settlementOut || freeC > 0)) {
      revert VaultErrors.SurplusRequiresInKind();
    }
    if (freeS < settlementOut) revert VaultErrors.InsufficientSettlement();

    _finishRedeemSettle(epochId, epoch, false, settlementOut, 0, price);
  }

  /// @inheritdoc IOperatorVault
  function settleRedeemInKind(
    uint256 epochId,
    VaultLib.NavAttestation calldata attestation,
    bytes calldata signature
  ) external override nonReentrant {
    Epoch storage epoch = _closedEpoch(epochId, false);
    _requireElapsed(epoch.closedAt, inKindExitTimeout);
    (uint256 price, uint256 supply,, uint256 freeS, uint256 freeC) =
      _attestedPrologue(epochId, attestation, signature);

    uint256 shares = epoch.assets;
    // Snapshot pro-rata while anyone else still holds shares, so a UniswapX
    // input pull above the attested floors cannot inflate this epoch's take.
    // Last-claimer live payout is only safe after pause (ERC-1271 dead).
    // Unpaused last-exit would underpay redeemers mid-fill and stamp the
    // swap output as orphaned NAV. When paused, use live as the floor so a
    // hostile risk key cannot settle a partial epoch at 0 and lock out
    // `settleRedeemEmergencyInKind`.
    if (shares == supply && !paused) revert VaultErrors.PauseRequired();
    uint256 floorS = paused ? freeS : attestation.freeSettlement;
    uint256 floorC = paused ? freeC : attestation.freeCorridor;
    uint256 settlementOut = _inKindLeg(shares, supply, floorS, freeS);
    uint256 corridorOut = _inKindLeg(shares, supply, floorC, freeC);
    _finishRedeemSettle(epochId, epoch, true, settlementOut, corridorOut, price);
  }

  /// @inheritdoc IOperatorVault
  /// @dev Last-resort exit when the risk signer cannot attest. Pause first so
  ///      Permit2 cannot pull mid-split. Pays live free balances, including
  ///      unattested surplus. The recall is best-effort and nothing here
  ///      touches the external protocol: whatever Aave cannot pay back is
  ///      booked as a pro-rata in-kind claim on the yield token, which the
  ///      redeemers collect at claim time. See `pendingYieldPull`.
  function settleRedeemEmergencyInKind(uint256 epochId) external override nonReentrant {
    if (!paused) revert VaultErrors.PauseRequired();
    Epoch storage epoch = _closedEpoch(epochId, false);
    _requireElapsed(epoch.closedAt, emergencyExitTimeout);
    // Best-effort: never reverts on the adapter, and returns only the free
    // part of what it could not bring back — a slice a previous emergency
    // exit already owes redeemers is left alone and not resold here.
    uint256 stranded = VaultPolicy.tryRecallAllIdle(yieldAdapter, _owedAssets());

    _checkpointFee();
    uint256 supply = totalSupply();
    uint256 freeS = _liquidSettlement();
    uint256 freeC = _freeCorridor();

    uint256 shares = epoch.assets;
    uint256 settlementOut;
    uint256 corridorOut;
    uint256 yieldOut;
    // One guard for all three legs: it is only here so a fully-drained supply
    // cannot divide by zero.
    if (shares > 0) {
      settlementOut = Math.mulDiv(freeS, shares, supply);
      corridorOut = Math.mulDiv(freeC, shares, supply);
      yieldOut = Math.mulDiv(stranded, shares, supply);
    }
    if (yieldOut > 0) {
      // Scaled: `yieldOut` is priced at this settlement's index, and both the
      // weight and the reserve have to survive the index moving under them.
      uint256 weight = yieldAdapter.toScaled(yieldOut);
      epoch.remainingYield = weight;
      outstandingYieldWeight += weight;
      pendingYieldPull += weight;
      emit RedeemYieldSettled(epochId, yieldOut);
    }
    // Booked first, then moved, so a blocked transfer only defers the tokens.
    _syncPendingYield();
    _finishRedeemSettle(epochId, epoch, true, settlementOut, corridorOut, 0);
  }

  /*//////////////////////////////////////////////////////////////
                                CLAIMS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IOperatorVault
  /// @dev Single claim path for deposits and redemptions. In-kind exits pay
  ///      both assets, so this cannot be ERC-7540 `withdraw`/`redeem`.
  function claim(uint256 requestId, address controller, address receiver) external override nonReentrant {
    if (receiver == address(0) || controller == address(0)) revert VaultErrors.ZeroAddress();
    _requireAuthorized(controller);
    if (requestClaimed[controller][requestId]) revert VaultErrors.AlreadyClaimed();

    uint256 units = requestUnits[controller][requestId];
    if (units == 0) revert VaultErrors.NothingToClaim();

    Epoch storage epoch = epochs[requestId];
    if (epoch.state != EpochState.Processed && epoch.state != EpochState.Voided && epoch.state != EpochState.Settled) {
      revert VaultErrors.EpochNotClaimable();
    }

    requestClaimed[controller][requestId] = true;
    requestUnits[controller][requestId] = 0;

    if (epoch.isDeposit && epoch.state == EpochState.Voided) {
      pendingSettlement -= units;
      epoch.assets -= units;
      settlementAsset.safeTransfer(receiver, units);
      emit Claimed(controller, receiver, requestId, 0, units, 0);
      return;
    }

    uint256 sharesOut;
    uint256 settlementOut;
    uint256 corridorOut;
    uint256 remaining = epoch.remainingUnits;
    epoch.remainingUnits = remaining - units;

    if (epoch.isDeposit && epoch.state == EpochState.Processed) {
      sharesOut = VaultLib.proRataWithResidue(units, remaining, epoch.shares);
      epoch.shares -= sharesOut;
      _transfer(address(this), receiver, sharesOut);
    } else {
      settlementOut = VaultLib.proRataWithResidue(units, remaining, epoch.remainingSettlement);
      corridorOut = VaultLib.proRataWithResidue(units, remaining, epoch.remainingCorridor);
      uint256 yieldWeight = VaultLib.proRataWithResidue(units, remaining, epoch.remainingYield);
      reservedSettlement -= settlementOut;
      reservedCorridor -= corridorOut;
      epoch.remainingSettlement -= settlementOut;
      epoch.remainingCorridor -= corridorOut;
      epoch.remainingYield -= yieldWeight;
      if (settlementOut > 0) settlementAsset.safeTransfer(receiver, settlementOut);
      if (corridorOut > 0) corridorAsset.safeTransfer(receiver, corridorOut);
      if (yieldWeight > 0) _payYield(controller, receiver, requestId, yieldWeight);
    }

    emit Claimed(controller, receiver, requestId, sharesOut, settlementOut, corridorOut);
  }

  /*//////////////////////////////////////////////////////////////
                             IDLE YIELD
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IOperatorVault
  /// @dev Strict: reverts unless the vault ends with at least `needed` liquid,
  ///      so an Aave-side shortfall (even 1 wei of rounding) cannot let a fill
  ///      pull against a short balance.
  function prepareSettlement(uint256 needed) external override nonReentrant {
    VaultPolicy.prepareIdle(yieldAdapter, _liquidSettlement(), needed, _owedAssets());
  }

  /// @inheritdoc IOperatorVault
  /// @dev Only idle settlement above `minLiquidSettlement` is supplied.
  ///      Pending deposits and reserved payouts are excluded from liquid, so
  ///      they can never end up in Aave. Corridor is never supplied.
  function allocateIdle() external override nonReentrant {
    if (address(yieldAdapter) == address(0)) return;
    VaultPolicy.allocateIdle(yieldAdapter, _liquidSettlement(), minLiquidSettlement, paused || closeOnly());
  }

  /// @inheritdoc IOperatorVault
  function recallAll() external override nonReentrant {
    _recallAll();
  }

  /*//////////////////////////////////////////////////////////////
                              PREVIEWS
  //////////////////////////////////////////////////////////////*/

  function previewDeposit(uint256) external pure returns (uint256) {
    revert VaultErrors.PreviewUnsupported();
  }

  function previewMint(uint256) external pure returns (uint256) {
    revert VaultErrors.PreviewUnsupported();
  }

  function previewWithdraw(uint256) external pure returns (uint256) {
    revert VaultErrors.PreviewUnsupported();
  }

  function previewRedeem(uint256) external pure returns (uint256) {
    revert VaultErrors.PreviewUnsupported();
  }

  function pendingDepositRequest(uint256 requestId, address controller) external view returns (uint256) {
    Epoch storage epoch = epochs[requestId];
    if (!epoch.isDeposit || (epoch.state != EpochState.Open && epoch.state != EpochState.Closed)) return 0;
    return requestUnits[controller][requestId];
  }

  function claimableDepositRequest(uint256 requestId, address controller) external view returns (uint256) {
    Epoch storage epoch = epochs[requestId];
    if (!epoch.isDeposit || requestClaimed[controller][requestId]) return 0;
    if (epoch.state != EpochState.Processed && epoch.state != EpochState.Voided) return 0;
    return requestUnits[controller][requestId];
  }

  function pendingRedeemRequest(uint256 requestId, address controller) external view returns (uint256) {
    Epoch storage epoch = epochs[requestId];
    if (epoch.isDeposit || (epoch.state != EpochState.Open && epoch.state != EpochState.Closed)) return 0;
    return requestUnits[controller][requestId];
  }

  function claimableRedeemRequest(uint256 requestId, address controller) external view returns (uint256) {
    Epoch storage epoch = epochs[requestId];
    if (epoch.isDeposit || epoch.state != EpochState.Settled || requestClaimed[controller][requestId]) return 0;
    return requestUnits[controller][requestId];
  }

  /*//////////////////////////////////////////////////////////////
                              ERC-1271
  //////////////////////////////////////////////////////////////*/

  /// @notice Validates a two-signature vault envelope at fill time.
  function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
    if (paused) return VaultLib.ERC1271_FAIL;
    return VaultPolicy.validateEnvelope(hash, signature, address(this));
  }

  /*//////////////////////////////////////////////////////////////
                                ADMIN
  //////////////////////////////////////////////////////////////*/

  function pause() external onlyGuardian {
    if (paused) revert VaultErrors.InvalidParams();
    paused = true;
    _bumpTradingEpoch();
    emit Paused(msg.sender);
  }

  function unpause() external onlyGuardian {
    if (!paused) revert VaultErrors.InvalidParams();
    paused = false;
    emit Unpaused(msg.sender);
  }

  function setStrategySigner(address next) external onlyOperatorAdmin {
    VaultPolicy.setStrategySigner(_roles, next, _bumpTradingEpoch());
  }

  /// @notice Proposing the zero address withdraws the pending proposal.
  function proposeRiskSigner(address next) external onlyRiskAdmin {
    VaultPolicy.proposeRiskSigner(_roles, next, riskSignerDelay);
  }

  function acceptRiskSigner() external {
    VaultPolicy.acceptRiskSigner(_roles, _bumpTradingEpoch());
  }

  /// @notice Two-step transfer: the new admin must accept, so a fat-finger or
  ///         hostile proposal cannot hand control over irrevocably. Proposing
  ///         the zero address withdraws the pending proposal.
  function transferOperatorAdmin(address next) external onlyOperatorAdmin {
    VaultPolicy.proposeOperatorAdmin(_roles, next);
  }

  function acceptOperatorAdmin() external {
    VaultPolicy.acceptOperatorAdmin(
      _roles, factory, address(settlementAsset), address(corridorAsset)
    );
  }

  /// @notice Two-step transfer, mirroring `transferOperatorAdmin`.
  function transferRiskAdmin(address next) external onlyRiskAdmin {
    VaultPolicy.proposeRiskAdmin(_roles, next);
  }

  function acceptRiskAdmin() external {
    VaultPolicy.acceptRiskAdmin(_roles);
  }

  /// @inheritdoc IOperatorVault
  function yieldReserves() external view override returns (uint256 weight, uint256 pendingPull) {
    return (outstandingYieldWeight, pendingYieldPull);
  }

  /// @inheritdoc IOperatorVault
  function sweepToken(address token, address to) external override onlyGuardian nonReentrant {
    VaultPolicy.sweepToken(token, to, address(settlementAsset), address(corridorAsset), yieldToken);
  }

  /// @inheritdoc IOperatorVault
  function sweepETH(address payable to) external override onlyGuardian nonReentrant {
    VaultPolicy.sweepETH(to);
  }

  function setGuardian(address next) external onlyOperatorAdmin {
    VaultPolicy.setGuardian(_roles, next);
  }

  function setFeeRecipient(address next) external onlyOperatorAdmin nonReentrant {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    _checkpointFee();
    emit FeeRecipientUpdated(_roles.feeRecipient, next);
    _roles.feeRecipient = next;
  }

  function setOperator(address operator, bool approved) external override returns (bool) {
    if (operator == address(0)) revert VaultErrors.ZeroAddress();
    isOperator[msg.sender][operator] = approved;
    emit OperatorSet(msg.sender, operator, approved);
    return true;
  }

  /*//////////////////////////////////////////////////////////////
                                VIEWS
  //////////////////////////////////////////////////////////////*/

  function operatorAdmin() public view override returns (address) {
    return _roles.operatorAdmin;
  }

  function pendingOperatorAdmin() external view override returns (address) {
    return _roles.pendingOperatorAdmin;
  }

  function strategySigner() public view override returns (address) {
    return _roles.strategySigner;
  }

  function riskAdmin() public view override returns (address) {
    return _roles.riskAdmin;
  }

  function pendingRiskAdmin() external view override returns (address) {
    return _roles.pendingRiskAdmin;
  }

  function riskSigner() public view override returns (address) {
    return _roles.riskSigner;
  }

  function pendingRiskSigner() external view override returns (address) {
    return _roles.pendingRiskSigner;
  }

  function pendingRiskSignerAt() external view override returns (uint256) {
    return _roles.pendingRiskSignerAt;
  }

  function guardian() public view override returns (address) {
    return _roles.guardian;
  }

  function feeRecipient() public view override returns (address) {
    return _roles.feeRecipient;
  }

  /// @inheritdoc IOperatorVault
  function closeOnly() public view override returns (bool) {
    return closedRedeemEpochId != 0;
  }

  /// @inheritdoc IOperatorVault
  function freeSettlement() public view override returns (uint256) {
    return _freeSettlement();
  }

  /// @inheritdoc IOperatorVault
  function liquidSettlement() public view override returns (uint256) {
    return _liquidSettlement();
  }

  /// @inheritdoc IOperatorVault
  function freeCorridor() public view override returns (uint256) {
    return _freeCorridor();
  }

  /// @inheritdoc IOperatorVault
  function quotableSettlement() public view override returns (uint256) {
    return VaultLib.quotable(_freeSettlement(), minReserveSettlement);
  }

  /// @inheritdoc IOperatorVault
  function quotableCorridor() public view override returns (uint256) {
    return VaultLib.quotable(_freeCorridor(), minReserveCorridor);
  }

  /// @inheritdoc IOperatorVault
  /// @dev Last settled NAV, not a live mark. Preview methods revert instead.
  function totalAssets() public view override returns (uint256) {
    return lastSettledNav;
  }

  function asset() external view returns (address) {
    return address(settlementAsset);
  }

  /// @notice Share units track settlement atomic units, so decimals match the asset.
  function decimals() public view override returns (uint8) {
    return settlementDecimals;
  }

  /*//////////////////////////////////////////////////////////////
                              INTERNAL
  //////////////////////////////////////////////////////////////*/

  function _openOrCurrentDepositEpoch() private returns (uint256 id) {
    id = currentDepositEpochId;
    // Past-cutoff epochs are skipped, not returned: deposits open a fresh
    // epoch instead of bricking until someone calls closeDepositEpoch.
    if (id != 0 && epochs[id].state == EpochState.Open && block.timestamp < epochs[id].cutoff) {
      return id;
    }
    id = nextEpochId++;
    currentDepositEpochId = id;
    uint256 cutoffTs = block.timestamp + depositEpochDuration;
    if (cutoffTs > type(uint64).max) revert VaultErrors.InvalidParams();
    epochs[id] = _newEpoch(true, uint64(cutoffTs));
  }

  function _openOrCurrentRedeemEpoch() private returns (uint256 id) {
    id = currentRedeemEpochId;
    if (id != 0 && epochs[id].state == EpochState.Open) return id;
    id = nextEpochId++;
    currentRedeemEpochId = id;
    epochs[id] = _newEpoch(false, 0);
  }

  function _newEpoch(bool isDeposit, uint64 cutoff) private view returns (Epoch memory) {
    return Epoch({
      state: EpochState.Open,
      isDeposit: isDeposit,
      openedAt: uint64(block.timestamp),
      cutoff: cutoff,
      closedAt: 0,
      assets: 0,
      shares: 0,
      remainingUnits: 0,
      remainingSettlement: 0,
      remainingCorridor: 0,
      remainingYield: 0
    });
  }

  function _finishRedeemSettle(
    uint256 epochId,
    Epoch storage epoch,
    bool inKind,
    uint256 settlementOut,
    uint256 corridorOut,
    uint256 price
  ) private {
    uint256 shares = epoch.assets;
    if (shares > 0) _burn(address(this), shares);
    reservedSettlement += settlementOut;
    reservedCorridor += corridorOut;
    epoch.remainingUnits = shares;
    epoch.remainingSettlement = settlementOut;
    epoch.remainingCorridor = corridorOut;
    epoch.state = EpochState.Settled;
    closedRedeemEpochId = 0;
    lastRedeemSettledAt = block.timestamp;
    _recordSettledNav(price);
    emit RedeemEpochSettled(epochId, inKind, shares, settlementOut, corridorOut);
  }

  function _recordSettledNav(uint256 price) private {
    // price == 0 is the emergency path: leftover settlement only.
    uint256 settled = price == 0 ? _freeSettlement() : _nav(price);
    lastSettledNav = settled;
    emit NavSettled(settled, block.timestamp);
  }

  function _checkpointFee() private {
    uint256 elapsed = block.timestamp - lastFeeCheckpoint;
    lastFeeCheckpoint = block.timestamp;
    uint256 shares = VaultLib.feeShares(totalSupply(), managementFeeWad, elapsed);
    if (shares == 0) return;
    address recipient = _roles.feeRecipient;
    _mint(recipient, shares);
    emit FeeAccrued(recipient, shares, elapsed);
  }

  /// @dev `startedAt` is always a past block timestamp, so the subtraction
  ///      cannot underflow.
  function _durationElapsed(uint256 startedAt, uint256 duration) private view returns (bool) {
    return block.timestamp - startedAt >= duration;
  }

  function _bumpTradingEpoch() private returns (uint256 epoch) {
    unchecked {
      epoch = ++tradingEpoch;
    }
  }

  function _inKindLeg(uint256 shares, uint256 supply, uint256 attested, uint256 live)
    private
    pure
    returns (uint256)
  {
    if (shares == 0) return 0;
    if (shares == supply) return live;
    return Math.mulDiv(attested, shares, supply);
  }

  /// @dev Settlement actually sitting in the vault, net of pending deposits
  ///      and reserved payouts. The only balance Permit2 can pull from.
  function _liquidSettlement() private view returns (uint256) {
    return settlementAsset.balanceOf(address(this)) - pendingSettlement - reservedSettlement;
  }

  /// @dev The adapter position net of value an emergency exit already
  ///      promised redeemers but could not move out yet — that slice stopped
  ///      backing live shares the moment the epoch settled.
  function _heldSettlement() private view returns (uint256) {
    if (address(yieldAdapter) == address(0)) return 0;
    uint256 held = yieldAdapter.held();
    uint256 owed = _owedAssets();
    return held > owed ? held - owed : 0;
  }

  /// @dev Economic free settlement: liquid plus the adapter position. NAV,
  ///      quotable, and attestation floors all price the full inventory.
  function _freeSettlement() private view returns (uint256) {
    return _liquidSettlement() + _heldSettlement();
  }

  function _requireElapsed(uint256 since, uint256 timeout) private view {
    if (!_durationElapsed(since, timeout)) revert VaultErrors.TimeoutNotReached();
  }

  /// @dev Every settlement path starts from the same guard.
  function _closedEpoch(uint256 epochId, bool isDeposit) private view returns (Epoch storage epoch) {
    epoch = epochs[epochId];
    if (epoch.isDeposit != isDeposit || epoch.state != EpochState.Closed) revert VaultErrors.EpochNotClosed();
  }

  /// @dev The deferred slice at today's face value. Zero short-circuits, so
  ///      the ordinary path — and `_freeSettlement`, which every fill
  ///      validation hits — never pays for the conversion.
  function _owedAssets() private view returns (uint256) {
    uint256 owed = pendingYieldPull;
    return owed == 0 ? 0 : yieldAdapter.fromScaled(owed);
  }

  function _recallAll() private {
    if (address(yieldAdapter) == address(0)) return;
    // Drain the deferred slice first so a recall that can reach it does, and
    // the reserve it has to leave behind shrinks to nothing.
    _syncPendingYield();
    VaultPolicy.recallAllIdle(yieldAdapter, _owedAssets());
  }

  /// @dev Best-effort pull of the deferred slice. Never reverts, so nothing
  ///      Aave does can block the caller. Silence means it is still stuck:
  ///      `RedeemYieldSettled` with no matching `YieldPullSynced`.
  function _syncPendingYield() private {
    uint256 owed = _owedAssets();
    if (owed == 0) return;
    if (VaultPolicy.syncPendingYield(yieldAdapter, owed)) pendingYieldPull = 0;
  }

  /// @dev Pay the in-kind yield leg. `weight` is a share of
  ///      `outstandingYieldWeight`, not an amount, so claimants split the live
  ///      balance and rebasing follows the claim. Splitting a face-value
  ///      balance by scaled weights is exact, since face value is scaled
  ///      units times one index shared by every holder. A slice still stuck
  ///      in the adapter is pulled first; if it will not move the claim
  ///      reverts rather than burning the weight against a short pool.
  function _payYield(address controller, address receiver, uint256 epochId, uint256 weight) private {
    _syncPendingYield();
    if (pendingYieldPull > 0) revert VaultErrors.YieldNotLiquid();
    uint256 outstanding = outstandingYieldWeight;
    outstandingYieldWeight = outstanding - weight;
    VaultPolicy.payYield(yieldToken, controller, receiver, epochId, weight, outstanding);
  }

  function _freeCorridor() private view returns (uint256) {
    return corridorAsset.balanceOf(address(this)) - reservedCorridor;
  }

  function _pullExact(IERC20 token, address from, uint256 amount) private {
    uint256 beforeBal = token.balanceOf(address(this));
    token.safeTransferFrom(from, address(this), amount);
    if (token.balanceOf(address(this)) - beforeBal != amount) revert VaultErrors.TransferMismatch();
  }

  function _nav(uint256 priceWad) private view returns (uint256) {
    return VaultLib.nav(_freeSettlement(), _freeCorridor(), priceWad, settlementDecimals, corridorDecimals);
  }

  /// @dev Shared prologue of the two attested settle paths: full recall,
  ///      verify the risk signature, checkpoint the fee, then read live NAV.
  function _attestedPrologue(uint256 epochId, VaultLib.NavAttestation calldata att, bytes calldata sig)
    private
    returns (uint256 price, uint256 supply, uint256 conversionNav, uint256 freeS, uint256 freeC)
  {
    _recallAll();
    price = VaultPolicy.verifyAttestation(att, sig, epochId, address(this), _roles.riskSigner);
    _checkpointFee();
    supply = totalSupply();
    (conversionNav, freeS, freeC) = _requireLiveNav(att, price);
  }

  /// @notice Attestations bind `lastSettledNav` so a prior epoch cannot be
  ///         replayed after settlement. Live free balances and live NAV must
  ///         be at least the signed snapshot: a UniswapX input pull that eats
  ///         attested inventory reverts. Surplus (donations, completed fills)
  ///         is allowed so it cannot grief settlement, but conversion uses
  ///         the signed NAV — live `balanceOf` can drop in
  ///         `executeWithCallback` while still sitting above the floors.
  ///         Surplus is marked in afterwards via `_recordSettledNav`.
  function _requireLiveNav(VaultLib.NavAttestation calldata att, uint256 priceWad)
    private
    view
    returns (uint256 conversionNav, uint256 freeS, uint256 freeC)
  {
    if (att.lastSettledNav != lastSettledNav) revert VaultErrors.InvalidAttestation();
    freeS = _freeSettlement();
    freeC = _freeCorridor();
    uint256 liveNav = VaultLib.nav(freeS, freeC, priceWad, settlementDecimals, corridorDecimals);
    if (liveNav < att.nav) revert VaultErrors.InconsistentNav();
    if (freeS < att.freeSettlement || freeC < att.freeCorridor) revert VaultErrors.InconsistentNav();
    conversionNav = att.nav;
  }

  function _requireAuthorized(address account) private view {
    if (msg.sender != account && !isOperator[account][msg.sender]) revert VaultErrors.NotAuthorized();
  }

  function _pullShares(address owner, uint256 shares) private {
    if (owner != msg.sender && !isOperator[owner][msg.sender]) {
      uint256 allowed = allowance(owner, msg.sender);
      if (allowed < shares) revert VaultErrors.NotAuthorized();
      _spendAllowance(owner, msg.sender, shares);
    }
    _transfer(owner, address(this), shares);
  }
}
