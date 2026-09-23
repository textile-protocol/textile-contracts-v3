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
import { IYieldAdapter } from "./interfaces/IYieldAdapter.sol";
import { VaultErrors } from "./libraries/VaultErrors.sol";
import { VaultLib } from "./libraries/VaultLib.sol";
import { VaultPolicy } from "./libraries/VaultPolicy.sol";
import { VaultTypes } from "./libraries/VaultTypes.sol";

/**
 * @title OperatorVault
 * @notice Immutable two-asset RFQ maker vault. LPs hold ERC-20 shares. The operator
 *         only signs constrained LimitOrders, validated through ERC-1271 before Permit2
 *         can pull. Deposits (settlement or corridor, separate epochs) and redemptions
 *         settle in aggregate epochs against a dual-signed NAV attestation. Redemptions
 *         pay both assets pro rata. One closed redeem epoch at a time puts the vault in
 *         close-only mode; pause is an independent flag on top.
 */
contract OperatorVault is ERC20, ReentrancyGuard, IERC1271, IOperatorVault, VaultErrors {
  using SafeERC20 for IERC20;

  /// @dev `claim` treats `Processed` and everything after it as claimable.
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
    /// @dev Deposit epochs only: `units` are corridor, not settlement.
    bool inCorridor;
    /// @dev Queued assets for a deposit epoch, shares for a redeem epoch.
    uint256 units;
    uint256 shares;
    uint256 remainingUnits;
    uint256 remainingSettlement;
    uint256 remainingCorridor;
    /// @dev In-kind yield claim, in scaled units. See `outstandingYieldWeight`.
    uint256 remainingYield;
  }

  IERC20 public immutable override settlementAsset;
  IERC20 public immutable override corridorAsset;
  address public immutable override factory;
  address public immutable reactor;
  address public immutable permit2;
  address public immutable preferredFillerValidation;
  uint256 public immutable maxOrderInputSettlement;
  uint256 public immutable maxOrderInputCorridor;
  uint256 public immutable minReserveSettlement;
  uint256 public immutable minReserveCorridor;
  uint256 public immutable maxOrderLifetime;
  uint256 public immutable depositEpochDuration;
  uint256 public immutable redemptionEpochDuration;
  uint256 public immutable redemptionCloseCooldown;
  uint256 public immutable emergencyExitTimeout;
  uint256 public immutable valuationTimeout;
  uint256 public immutable managementFeeWad;
  /// @notice Share of NAV over `basketMark`, capped at NAV over `highWaterMarkWad` when
  ///         `perfFloorEnabled`. WAD; zero = off.
  uint256 public immutable performanceFeeWad;
  /// @notice Whether the performance fee waits for the all-time-high price per share.
  bool public immutable override perfFloorEnabled;
  uint256 public immutable riskSignerDelay;
  uint256 public immutable minDepositAssets;
  /// @notice In corridor units. Zero disables corridor deposits.
  uint256 public immutable minDepositCorridor;
  uint256 public immutable minRedeemShares;
  uint8 public immutable override settlementDecimals;
  uint8 public immutable override corridorDecimals;
  /// @notice Optional idle-yield adapter for the settlement asset. Zero = off.
  IYieldAdapter public immutable yieldAdapter;
  /// @notice Liquid settlement `allocateIdle` never supplies below. Shapes what idle
  ///         goes to the adapter only, never what an order may pull or a redeemer is paid.
  uint256 public minLiquidSettlement;
  /// @dev Token the adapter position is held in (e.g. the aToken). Zero when yield is off.
  ///      Not public: bytecode budget. Read `yieldAdapter().yieldToken()` off-chain.
  address internal immutable yieldToken;

  VaultTypes.Roles private _roles;

  bool public override paused;
  uint256 public override tradingEpoch;
  uint256 public nextEpochId;
  uint256 public currentDepositEpochId;
  uint256 public currentCorridorDepositEpochId;
  uint256 public currentRedeemEpochId;
  uint256 public closedRedeemEpochId;
  uint256 public lastFeeCheckpoint;
  /// @notice Performance-fee absolute mark, WAD assets per share. Only ever rises.
  uint256 public highWaterMarkWad;
  /// @notice Per-share inventory the performance fee was last charged against.
  VaultTypes.BasketMark public basketMark;
  uint256 public lastSettledNav;
  uint256 public lastRedeemSettledAt;
  uint256 public pendingSettlement;
  uint256 public pendingCorridor;
  uint256 public reservedSettlement;
  uint256 public reservedCorridor;
  /// @dev Sum of unclaimed `Epoch.remainingYield`. A weight over the live yield-token
  ///      balance, in the adapter's scaled units, so accrual after settlement follows the claim.
  uint256 internal outstandingYieldWeight;
  /// @dev Scaled position an emergency exit owes redeemers but could not move out of the
  ///      adapter yet. Excluded from NAV. Face value via `_owedAssets`.
  uint256 internal pendingYieldPull;

  mapping(uint256 => Epoch) public epochs;
  mapping(address => mapping(uint256 => uint256)) public requestUnits;
  mapping(address => mapping(uint256 => bool)) public requestClaimed;
  mapping(address => mapping(address => bool)) public isOperator;

  event DepositRequest(
    address indexed controller,
    address indexed owner,
    uint256 indexed requestId,
    address sender,
    uint256 assets,
    bool inCorridor
  );
  event DepositCancelled(address indexed controller, uint256 indexed epochId, uint256 assets);
  event RedeemRequest(
    address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares
  );
  event EpochClosed(uint256 indexed epochId, bool isDeposit, uint256 units);
  /// @dev `price` is the attested corridor price the epoch converted at; an empty epoch reports zeros.
  event DepositEpochProcessed(uint256 indexed epochId, uint256 assets, uint256 shares, uint256 price);
  event DepositEpochVoided(uint256 indexed epochId);
  event RedeemEpochSettled(uint256 indexed epochId, uint256 shares, uint256 settlementOut, uint256 corridorOut);
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

  constructor(VaultTypes.VaultConfig memory cfg, string memory name_, string memory symbol_)
    ERC20(name_, symbol_)
  {
    (settlementDecimals, corridorDecimals) = VaultPolicy.validateConfig(cfg);

    settlementAsset = cfg.settlementAsset;
    corridorAsset = cfg.corridorAsset;
    factory = msg.sender;
    reactor = cfg.reactor;
    permit2 = cfg.permit2;
    preferredFillerValidation = cfg.preferredFillerValidation;
    maxOrderInputSettlement = cfg.maxOrderInputSettlement;
    maxOrderInputCorridor = cfg.maxOrderInputCorridor;
    minReserveSettlement = cfg.minReserveSettlement;
    minReserveCorridor = cfg.minReserveCorridor;
    maxOrderLifetime = cfg.maxOrderLifetime;
    depositEpochDuration = cfg.depositEpochDuration;
    redemptionEpochDuration = cfg.redemptionEpochDuration;
    redemptionCloseCooldown = cfg.redemptionCloseCooldown;
    emergencyExitTimeout = cfg.emergencyExitTimeout;
    valuationTimeout = cfg.valuationTimeout;
    managementFeeWad = cfg.managementFeeWad;
    performanceFeeWad = cfg.performanceFeeWad;
    perfFloorEnabled = cfg.perfFloorEnabled;
    riskSignerDelay = cfg.riskSignerDelay;
    minDepositAssets = cfg.minDepositAssets;
    minDepositCorridor = cfg.minDepositCorridor;
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

    // Bound in the factory tx, so there is no front-run window on the fresh clone.
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
    requestId = _requestDeposit(false, assets, controller, owner);
  }

  /// @inheritdoc IOperatorVault
  function requestDepositCorridor(uint256 assets, address controller, address owner)
    external
    override
    nonReentrant
    returns (uint256 requestId)
  {
    requestId = _requestDeposit(true, assets, controller, owner);
  }

  /// @inheritdoc IOperatorVault
  /// @dev Refunds the controller, not the depositing owner (ERC-7540 controller model).
  function cancelDeposit(uint256 requestId, address controller) external override nonReentrant {
    Epoch storage epoch = epochs[requestId];
    if (!epoch.isDeposit || epoch.state != EpochState.Open) revert VaultErrors.EpochNotOpen();
    if (block.timestamp >= epoch.cutoff) revert VaultErrors.CancelWindowClosed();
    _requireAuthorized(controller);

    uint256 assets = requestUnits[controller][requestId];
    if (assets == 0) revert VaultErrors.NothingToClaim();

    requestUnits[controller][requestId] = 0;
    epoch.units -= assets;
    _refundPending(epoch.inCorridor, controller, assets);

    emit DepositCancelled(controller, requestId, assets);
  }

  /// @inheritdoc IOperatorVault
  function closeDepositEpoch(uint256 epochId) external override {
    Epoch storage epoch = epochs[epochId];
    if (!epoch.isDeposit || epoch.state != EpochState.Open) revert VaultErrors.EpochNotOpen();
    if (block.timestamp < epoch.cutoff) revert VaultErrors.EpochNotReady();
    // At most one matches; branching on `inCorridor` costs more bytecode than both compares.
    if (currentDepositEpochId == epochId) currentDepositEpochId = 0;
    if (currentCorridorDepositEpochId == epochId) currentCorridorDepositEpochId = 0;
    _closeEpoch(epochId, epoch);
  }

  /// @inheritdoc IOperatorVault
  function processDepositEpoch(
    uint256 epochId,
    VaultLib.NavAttestation calldata attestation,
    bytes calldata strategySignature,
    bytes calldata riskSignature
  ) external override nonReentrant {
    if (paused) revert VaultErrors.EnforcedPause();
    Epoch storage epoch = _closedEpoch(epochId, true);
    if (epoch.units == 0) {
      epoch.state = EpochState.Processed;
      // The attestation is unverified on this path, so its price must not reach the log.
      emit DepositEpochProcessed(epochId, 0, 0, 0);
      return;
    }

    // NAV before the checkpoint, supply after: this epoch converts at the post-fee price.
    (uint256 price,,) = _verifiedLiveNav(epochId, attestation, strategySignature, riskSignature);
    _checkpointFee(attestation.freeSettlement, attestation.freeCorridor, price);

    uint256 supply = totalSupply();
    uint256 assets = epoch.units;
    bool inCorridor = epoch.inCorridor;
    uint256 value =
      inCorridor ? VaultLib.nav(0, assets, price, settlementDecimals, corridorDecimals) : assets;
    // With no supply the epoch mints at its own value; any surplus already here becomes NAV
    // its depositors share. Converting against the signed NAV instead let a bare transfer
    // between close and process shrink the epoch to one share (audit H-02).
    uint256 shares =
      VaultLib.convertToShares(value, supply, supply == 0 ? 0 : attestation.nav, Math.Rounding.Floor);
    if (shares == 0) revert VaultErrors.ZeroAmount();

    _releasePending(inCorridor, assets);
    _mint(address(this), shares);
    VaultPolicy.absorbDeposit(
      basketMark,
      highWaterMarkWad,
      supply,
      shares,
      assets,
      inCorridor,
      attestation.freeSettlement,
      attestation.freeCorridor
    );

    epoch.shares = shares;
    epoch.remainingUnits = assets;
    epoch.state = EpochState.Processed;

    _recordSettledNav(price);
    emit DepositEpochProcessed(epochId, assets, shares, price);
  }

  /// @inheritdoc IOperatorVault
  /// @dev No key, no pause check, works while wedged: with `settleRedeemEmergencyInKind`
  ///      this is why an abandoned vault is never a permanent lock. Attestations stop
  ///      verifying at `valuationTimeout` too, so this and `processDepositEpoch` share one second.
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
  /// @dev No pause check: exits must always be able to queue.
  function requestRedeem(uint256 shares, address controller, address owner)
    external
    override
    nonReentrant
    returns (uint256 requestId)
  {
    VaultPolicy.validateRedeemRequest(shares, minRedeemShares, balanceOf(owner), controller, owner);

    requestId = _openOrCurrentRedeemEpoch();
    _pullShares(owner, shares);
    epochs[requestId].units += shares;
    requestUnits[controller][requestId] += shares;

    emit RedeemRequest(controller, owner, requestId, msg.sender, shares);
  }

  /// @inheritdoc IOperatorVault
  /// @dev The operator closes whenever it likes. Anyone else waits `valuationTimeout` on
  ///      top of the duration, otherwise one `minRedeemShares` holder could force a
  ///      re-quote of the whole book every cycle (audit v0.2 L-02).
  function closeRedeemEpoch(uint256 epochId) external override {
    if (closedRedeemEpochId != 0) revert VaultErrors.RedeemEpochOutstanding();
    Epoch storage epoch = epochs[epochId];
    if (epoch.isDeposit || epoch.state != EpochState.Open) revert VaultErrors.EpochNotOpen();
    if (msg.sender != _roles.operatorAdmin && msg.sender != _roles.strategySigner) {
      if (!_durationElapsed(epoch.openedAt, redemptionEpochDuration + valuationTimeout)) {
        revert VaultErrors.EpochNotReady();
      }
      if (lastRedeemSettledAt != 0 && !_durationElapsed(lastRedeemSettledAt, redemptionCloseCooldown)) {
        revert VaultErrors.CloseCooldownActive();
      }
    }

    closedRedeemEpochId = epochId;
    if (currentRedeemEpochId == epochId) currentRedeemEpochId = 0;
    _bumpTradingEpoch();
    _closeEpoch(epochId, epoch);
  }

  /// @inheritdoc IOperatorVault
  function settleRedeemEpoch(
    uint256 epochId,
    VaultLib.NavAttestation calldata attestation,
    bytes calldata strategySignature,
    bytes calldata riskSignature
  ) external override nonReentrant {
    Epoch storage epoch = _closedEpoch(epochId, false);
    _recallAll();
    (uint256 price, uint256 freeS, uint256 freeC) =
      _verifiedLiveNav(epochId, attestation, strategySignature, riskSignature);
    // Unpaused: pay off the attested floors so an in-flight Permit2 pull cannot inflate the take.
    // Paused: ERC-1271 is dead, so live is the floor and hostile signers cannot settle a partial
    // epoch at 0 to lock out `settleRedeemEmergencyInKind`. The fee is charged on the same floors.
    bool isPaused = paused;
    uint256 floorS = isPaused ? freeS : attestation.freeSettlement;
    uint256 floorC = isPaused ? freeC : attestation.freeCorridor;
    _checkpointFee(floorS, floorC, price);
    uint256 supply = totalSupply();

    uint256 shares = epoch.units;
    if (shares == supply && !isPaused) revert VaultErrors.PauseRequired();
    uint256 settlementOut = Math.mulDiv(floorS, shares, supply);
    uint256 corridorOut = Math.mulDiv(floorC, shares, supply);
    _finishRedeemSettle(epochId, epoch, settlementOut, corridorOut, price);
  }

  /// @inheritdoc IOperatorVault
  /// @dev Pauses first if the guardian has not: an unpaused split could race a Permit2 pull.
  ///      The unattested span's management fee is forfeited: the clock resets, nothing is banked.
  function settleRedeemEmergencyInKind(uint256 epochId) external override nonReentrant {
    Epoch storage epoch = _closedEpoch(epochId, false);
    _requireElapsed(epoch.closedAt, emergencyExitTimeout);
    lastFeeCheckpoint = block.timestamp;
    if (!paused) _pause();
    uint256 stranded = VaultPolicy.tryRecallAllIdle(yieldAdapter, _owedAssets());

    uint256 supply = totalSupply();
    uint256 freeS = _liquidSettlement();
    uint256 freeC = _freeCorridor();

    uint256 shares = epoch.units;
    uint256 settlementOut = Math.mulDiv(freeS, shares, supply);
    uint256 corridorOut = Math.mulDiv(freeC, shares, supply);
    uint256 yieldOut = Math.mulDiv(stranded, shares, supply);
    if (yieldOut > 0) {
      // Scaled so the weight and the reserve survive the index moving under them.
      uint256 weight = yieldAdapter.toScaled(yieldOut);
      epoch.remainingYield = weight;
      outstandingYieldWeight += weight;
      pendingYieldPull += weight;
      emit RedeemYieldSettled(epochId, yieldOut);
    }
    // Booked first, then moved, so a blocked transfer only defers the tokens.
    _syncPendingYield();
    _finishRedeemSettle(epochId, epoch, settlementOut, corridorOut, 0);
  }

  /*//////////////////////////////////////////////////////////////
                                CLAIMS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IOperatorVault
  function claim(uint256 requestId, address controller, address receiver) external override nonReentrant {
    if (receiver == address(0) || controller == address(0)) revert VaultErrors.ZeroAddress();
    if (receiver == address(this)) revert VaultErrors.InvalidParams();
    _requireAuthorized(controller);
    if (requestClaimed[controller][requestId]) revert VaultErrors.AlreadyClaimed();

    uint256 units = requestUnits[controller][requestId];
    if (units == 0) revert VaultErrors.NothingToClaim();

    Epoch storage epoch = epochs[requestId];
    if (epoch.state < EpochState.Processed) revert VaultErrors.EpochNotClaimable();

    requestClaimed[controller][requestId] = true;
    requestUnits[controller][requestId] = 0;

    if (epoch.isDeposit && epoch.state == EpochState.Voided) {
      epoch.units -= units;
      bool inCorridor = epoch.inCorridor;
      _refundPending(inCorridor, receiver, units);
      // if/else rather than two ternaries: SlithIR cannot lower a ternary here,
      // in an event arg or in the initialiser of a local declaration.
      uint256 refundSettlement;
      uint256 refundCorridor;
      if (inCorridor) refundCorridor = units;
      else refundSettlement = units;
      emit Claimed(controller, receiver, requestId, 0, refundSettlement, refundCorridor);
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
      epoch.remainingSettlement -= settlementOut;
      epoch.remainingCorridor -= corridorOut;
      epoch.remainingYield -= yieldWeight;
      // Each reserve is released right before its own transfer, so a transfer callback
      // never sees a leg unreserved while its tokens are still here.
      if (settlementOut > 0) {
        reservedSettlement -= settlementOut;
        settlementAsset.safeTransfer(receiver, settlementOut);
      }
      if (corridorOut > 0) {
        reservedCorridor -= corridorOut;
        corridorAsset.safeTransfer(receiver, corridorOut);
      }
      if (yieldWeight > 0) _payYield(controller, receiver, requestId, yieldWeight);
    }

    emit Claimed(controller, receiver, requestId, sharesOut, settlementOut, corridorOut);
  }

  /*//////////////////////////////////////////////////////////////
                             IDLE YIELD
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IOperatorVault
  function prepareSettlement(uint256 needed) external override nonReentrant {
    VaultPolicy.prepareIdle(yieldAdapter, _liquidSettlement(), needed, _owedAssets());
  }

  /// @inheritdoc IOperatorVault
  function allocateIdle() external override nonReentrant {
    if (address(yieldAdapter) == address(0)) return;
    VaultPolicy.allocateIdle(yieldAdapter, _liquidSettlement(), minLiquidSettlement, paused || closeOnly());
  }

  /// @inheritdoc IOperatorVault
  function recallAll() external override nonReentrant {
    _recallAll();
  }

  /*//////////////////////////////////////////////////////////////
                              ERC-1271
  //////////////////////////////////////////////////////////////*/

  /// @notice Validates a two-signature vault envelope at fill time.
  /// @dev Reads the adapter via `_freeSettlement()`, so a reverting Aave view fails every fill.
  function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
    if (paused) return VaultLib.ERC1271_FAIL;
    // A view can't take `nonReentrant`, but it can refuse: mid-call (e.g. a token
    // callback in `claim`) the inventory reads below may be half-updated.
    if (_reentrancyGuardEntered()) return VaultLib.ERC1271_FAIL;
    return VaultPolicy.validateEnvelope(hash, signature, address(this));
  }

  /*//////////////////////////////////////////////////////////////
                                ADMIN
  //////////////////////////////////////////////////////////////*/

  /// @dev Banks the management fee earned up to here, so it is guarded like `setFeeRecipient`.
  function pause() external onlyGuardian nonReentrant {
    if (paused) revert VaultErrors.InvalidParams();
    _checkpointFee(0, 0, 0);
    _pause();
  }

  /// @dev The fee clock restarts here: the paused span is not charged.
  function unpause() external onlyGuardian {
    if (!paused) revert VaultErrors.InvalidParams();
    paused = false;
    lastFeeCheckpoint = block.timestamp;
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

  /// @notice Two-step: the new admin must accept. Proposing zero withdraws the proposal.
  function transferOperatorAdmin(address next) external onlyOperatorAdmin {
    VaultPolicy.proposeOperatorAdmin(_roles, next);
  }

  function acceptOperatorAdmin() external {
    VaultPolicy.acceptOperatorAdmin(
      _roles, factory, address(settlementAsset), address(corridorAsset)
    );
  }

  /// @notice Two-step, mirroring `transferOperatorAdmin`.
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

  /// @notice Retune the liquid floor. A no-op write is refused so every event marks a change.
  /// @dev No trading-epoch bump: the floor is not part of order validation. Raising it does
  ///      not recall; liquid reaches the new floor through `recallAll` or fresh inflows.
  function setMinLiquidSettlement(uint256 next) external onlyOperatorAdmin {
    uint256 previous = minLiquidSettlement;
    if (address(yieldAdapter) == address(0) || next == previous) revert VaultErrors.InvalidParams();
    minLiquidSettlement = next;
    emit MinLiquidSettlementUpdated(previous, next);
  }

  /// @dev Guarded because it mints via `_checkpointFee`; the other setters call nothing.
  function setFeeRecipient(address next) external onlyOperatorAdmin nonReentrant {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    if (next == address(this)) revert VaultErrors.InvalidParams();
    _checkpointFee(0, 0, 0);
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
  function totalAssets() public view override returns (uint256) {
    return lastSettledNav;
  }

  /// @notice Shares track settlement atomic units, so decimals match the asset.
  function decimals() public view override returns (uint8) {
    return settlementDecimals;
  }

  /*//////////////////////////////////////////////////////////////
                              INTERNAL
  //////////////////////////////////////////////////////////////*/

  function _requestDeposit(bool inCorridor, uint256 assets, address controller, address owner)
    private
    returns (uint256 requestId)
  {
    if (paused) revert VaultErrors.EnforcedPause();
    uint256 minimum = inCorridor ? minDepositCorridor : minDepositAssets;
    if (inCorridor && minimum == 0) revert VaultErrors.CorridorDepositsDisabled();
    if (assets < minimum) revert VaultErrors.BelowMinSize();
    if (controller == address(0) || owner == address(0)) revert VaultErrors.ZeroAddress();
    // The vault never calls setOperator, so nothing could claim such a request.
    if (controller == address(this)) revert VaultErrors.InvalidParams();
    _requireAuthorized(owner);

    requestId = _openOrCurrentDepositEpoch(inCorridor);
    Epoch storage epoch = epochs[requestId];

    _pullExact(inCorridor ? corridorAsset : settlementAsset, owner, assets);
    if (inCorridor) pendingCorridor += assets;
    else pendingSettlement += assets;
    epoch.units += assets;
    requestUnits[controller][requestId] += assets;

    emit DepositRequest(controller, owner, requestId, msg.sender, assets, inCorridor);
  }

  function _releasePending(bool inCorridor, uint256 assets) private {
    if (inCorridor) pendingCorridor -= assets;
    else pendingSettlement -= assets;
  }

  function _refundPending(bool inCorridor, address to, uint256 assets) private {
    _releasePending(inCorridor, assets);
    (inCorridor ? corridorAsset : settlementAsset).safeTransfer(to, assets);
  }

  /// @dev A past-cutoff epoch is skipped, not returned, so deposits never wait on a close.
  function _openOrCurrentDepositEpoch(bool inCorridor) private returns (uint256 id) {
    id = inCorridor ? currentCorridorDepositEpochId : currentDepositEpochId;
    if (id != 0 && epochs[id].state == EpochState.Open && block.timestamp < epochs[id].cutoff) {
      return id;
    }
    id = nextEpochId++;
    if (inCorridor) currentCorridorDepositEpochId = id;
    else currentDepositEpochId = id;
    // Durations are capped at half the uint64 range, so the sum fits.
    _openEpoch(id, true, inCorridor, uint64(block.timestamp + depositEpochDuration));
  }

  /// @dev No cutoff: a redeem epoch stays Open until `closeRedeemEpoch`.
  function _openOrCurrentRedeemEpoch() private returns (uint256 id) {
    id = currentRedeemEpochId;
    if (id != 0 && epochs[id].state == EpochState.Open) return id;
    id = nextEpochId++;
    currentRedeemEpochId = id;
    _openEpoch(id, false, false, 0);
  }

  function _openEpoch(uint256 id, bool isDeposit, bool inCorridor, uint64 cutoff) private {
    Epoch storage epoch = epochs[id];
    epoch.state = EpochState.Open;
    epoch.isDeposit = isDeposit;
    epoch.openedAt = uint64(block.timestamp);
    epoch.cutoff = cutoff;
    epoch.inCorridor = inCorridor;
  }

  function _closeEpoch(uint256 id, Epoch storage epoch) private {
    epoch.state = EpochState.Closed;
    epoch.closedAt = uint64(block.timestamp);
    emit EpochClosed(id, epoch.isDeposit, epoch.units);
  }

  function _finishRedeemSettle(
    uint256 epochId,
    Epoch storage epoch,
    uint256 settlementOut,
    uint256 corridorOut,
    uint256 price
  ) private {
    uint256 shares = epoch.units;
    _burn(address(this), shares);
    reservedSettlement += settlementOut;
    reservedCorridor += corridorOut;
    epoch.remainingUnits = shares;
    epoch.remainingSettlement = settlementOut;
    epoch.remainingCorridor = corridorOut;
    epoch.state = EpochState.Settled;
    closedRedeemEpochId = 0;
    lastRedeemSettledAt = block.timestamp;
    _recordSettledNav(price);
    emit RedeemEpochSettled(epochId, shares, settlementOut, corridorOut);
  }

  /// @dev Price zero is the emergency path: leftover settlement only.
  function _recordSettledNav(uint256 price) private {
    uint256 settled = price == 0 ? _freeSettlement() : _nav(price);
    lastSettledNav = settled;
    emit NavSettled(settled, block.timestamp);
  }

  /// @dev Prices the given inventory; a zero `priceWad` (the unpriced paths) skips the performance leg.
  ///      The management leg is earned only while open: paused, no time is charged.
  function _checkpointFee(uint256 freeS, uint256 freeC, uint256 priceWad) private {
    uint256 elapsed = paused ? 0 : block.timestamp - lastFeeCheckpoint;
    lastFeeCheckpoint = block.timestamp;
    uint256 mark = highWaterMarkWad;
    (uint256 operatorShares, uint256 protocolShares, address protocolRecipient, uint256 newMark) =
      VaultPolicy.checkpointAccrual(
        basketMark,
        VaultPolicy.Checkpoint({
          supply: totalSupply(),
          elapsed: elapsed,
          freeSettlement: freeS,
          freeCorridor: freeC,
          priceWad: priceWad,
          markWad: mark,
          managementFeeWad: managementFeeWad,
          performanceFeeWad: performanceFeeWad
        })
      );
    if (newMark != mark) highWaterMarkWad = newMark;
    _accrueFee(_roles.feeRecipient, operatorShares, elapsed);
    _accrueFee(protocolRecipient, protocolShares, elapsed);
  }

  function _accrueFee(address recipient, uint256 shares, uint256 elapsed) private {
    if (shares == 0) return;
    _mint(recipient, shares);
    emit FeeAccrued(recipient, shares, elapsed);
  }

  function _durationElapsed(uint256 startedAt, uint256 duration) private view returns (bool) {
    return block.timestamp - startedAt >= duration;
  }

  function _requireElapsed(uint256 since, uint256 timeout) private view {
    if (!_durationElapsed(since, timeout)) revert VaultErrors.TimeoutNotReached();
  }

  /// @dev Kills ERC-1271 and every outstanding order. Calls nothing, so the emergency exit
  ///      cannot be blocked here.
  function _pause() private {
    paused = true;
    _bumpTradingEpoch();
    emit Paused(msg.sender);
  }

  function _bumpTradingEpoch() private returns (uint256 epoch) {
    unchecked {
      epoch = ++tradingEpoch;
    }
  }

  /// @dev Settlement in the vault net of pending deposits and reserved payouts. The only
  ///      balance Permit2 can pull from.
  function _liquidSettlement() private view returns (uint256) {
    return settlementAsset.balanceOf(address(this)) - pendingSettlement - reservedSettlement;
  }

  /// @dev Adapter position net of the slice an emergency exit already promised redeemers.
  function _heldSettlement() private view returns (uint256) {
    if (address(yieldAdapter) == address(0)) return 0;
    uint256 held = yieldAdapter.held();
    uint256 owed = _owedAssets();
    return held > owed ? held - owed : 0;
  }

  /// @dev Economic free settlement: liquid plus the adapter position. Hot path: every fill
  ///      validation reads it.
  function _freeSettlement() private view returns (uint256) {
    return _liquidSettlement() + _heldSettlement();
  }

  function _closedEpoch(uint256 epochId, bool isDeposit) private view returns (Epoch storage epoch) {
    epoch = epochs[epochId];
    if (epoch.isDeposit != isDeposit || epoch.state != EpochState.Closed) revert VaultErrors.EpochNotClosed();
  }

  /// @dev The deferred slice at today's face value. Zero short-circuits so the ordinary
  ///      path never pays for the conversion.
  function _owedAssets() private view returns (uint256) {
    uint256 owed = pendingYieldPull;
    return owed == 0 ? 0 : yieldAdapter.fromScaled(owed);
  }

  function _recallAll() private {
    if (address(yieldAdapter) == address(0)) return;
    // Drain the deferred slice first so the reserve the recall leaves behind shrinks.
    _syncPendingYield();
    VaultPolicy.recallAllIdle(yieldAdapter, _owedAssets());
  }

  /// @dev Best-effort pull of the deferred slice. Never reverts.
  function _syncPendingYield() private {
    uint256 owed = _owedAssets();
    if (owed == 0) return;
    if (VaultPolicy.syncPendingYield(yieldAdapter, owed)) pendingYieldPull = 0;
  }

  /// @dev A slice still stuck in the adapter is pulled first; if it will not move the claim
  ///      reverts rather than burning the weight against a short pool.
  function _payYield(address controller, address receiver, uint256 epochId, uint256 weight) private {
    _syncPendingYield();
    if (pendingYieldPull > 0) revert VaultErrors.YieldNotLiquid();
    uint256 outstanding = outstandingYieldWeight;
    outstandingYieldWeight = outstanding - weight;
    VaultPolicy.payYield(yieldToken, controller, receiver, epochId, weight, outstanding);
  }

  /// @dev Corridor net of reserved payouts and pending deposits. The only corridor a fill can sell.
  function _freeCorridor() private view returns (uint256) {
    return corridorAsset.balanceOf(address(this)) - reservedCorridor - pendingCorridor;
  }

  function _pullExact(IERC20 token, address from, uint256 amount) private {
    uint256 beforeBal = token.balanceOf(address(this));
    token.safeTransferFrom(from, address(this), amount);
    if (token.balanceOf(address(this)) - beforeBal != amount) revert VaultErrors.TransferMismatch();
  }

  function _nav(uint256 priceWad) private view returns (uint256) {
    return VaultLib.nav(_freeSettlement(), _freeCorridor(), priceWad, settlementDecimals, corridorDecimals);
  }

  /// @dev Binds the attestation to `lastSettledNav` (no replay) and to its own floors (no NAV the
  ///      floors do not back), then requires live balances at or above those floors. Surplus is
  ///      allowed so it cannot grief settlement; `_recordSettledNav` marks it in afterwards.
  function _verifiedLiveNav(
    uint256 epochId,
    VaultLib.NavAttestation calldata att,
    bytes calldata strategySignature,
    bytes calldata riskSignature
  ) private view returns (uint256 priceWad, uint256 freeS, uint256 freeC) {
    priceWad = VaultPolicy.verifyAttestation(att, strategySignature, riskSignature, epochId, address(this));
    if (att.lastSettledNav != lastSettledNav) revert VaultErrors.InvalidAttestation();
    if (
      att.nav != VaultLib.nav(att.freeSettlement, att.freeCorridor, priceWad, settlementDecimals, corridorDecimals)
    ) revert VaultErrors.InvalidAttestation();
    freeS = _freeSettlement();
    freeC = _freeCorridor();
    if (freeS < att.freeSettlement || freeC < att.freeCorridor) revert VaultErrors.InconsistentNav();
  }

  function _requireAuthorized(address account) private view {
    if (msg.sender != account && !isOperator[account][msg.sender]) revert VaultErrors.NotAuthorized();
  }

  function _pullShares(address owner, uint256 shares) private {
    if (owner != msg.sender && !isOperator[owner][msg.sender]) _spendAllowance(owner, msg.sender, shares);
    _transfer(owner, address(this), shares);
  }
}
