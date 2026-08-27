// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IOperatorVault } from "./interfaces/IOperatorVault.sol";
import { IOperatorVaultFactory } from "./interfaces/IOperatorVaultFactory.sol";
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
contract OperatorVault is ERC20, ReentrancyGuard, IERC1271, IOperatorVault {
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

  address public operatorAdmin;
  address public strategySigner;
  address public riskAdmin;
  address public riskSigner;
  address public pendingRiskSigner;
  uint256 public pendingRiskSignerAt;
  address public guardian;
  address public feeRecipient;

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
  event Claimed(
    address indexed controller,
    address indexed receiver,
    uint256 indexed epochId,
    uint256 sharesOut,
    uint256 settlementOut,
    uint256 corridorOut
  );
  event Paused(address indexed guardian);
  event Unpaused(address indexed guardian);
  event StrategySignerRotated(address indexed previous, address indexed current, uint256 tradingEpoch);
  event RiskSignerProposed(address indexed pending, uint256 applyAt);
  event RiskSignerRotated(address indexed previous, address indexed current, uint256 tradingEpoch);
  event OperatorAdminTransferred(address indexed previous, address indexed current);
  event RiskAdminTransferred(address indexed previous, address indexed current);
  event GuardianUpdated(address indexed previous, address indexed current);
  event FeeRecipientUpdated(address indexed previous, address indexed current);
  event FeeAccrued(address indexed recipient, uint256 shares, uint256 elapsed);
  event NavSettled(uint256 nav, uint256 timestamp);
  event OperatorSet(address indexed account, address indexed operator, bool approved);
  event TokenSwept(address indexed token, address indexed to, uint256 amount);
  event ETHSwept(address indexed to, uint256 amount);

  modifier onlyOperatorAdmin() {
    if (msg.sender != operatorAdmin) revert VaultErrors.NotAuthorized();
    _;
  }

  modifier onlyRiskAdmin() {
    if (msg.sender != riskAdmin) revert VaultErrors.NotAuthorized();
    _;
  }

  modifier onlyGuardian() {
    if (msg.sender != guardian) revert VaultErrors.NotAuthorized();
    _;
  }

  constructor(VaultTypes.VaultConfig memory cfg) ERC20("Textile Operator Vault", "tOV") {
    VaultPolicy.validateConfig(cfg);

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
    settlementDecimals = IERC20Metadata(address(cfg.settlementAsset)).decimals();
    corridorDecimals = IERC20Metadata(address(cfg.corridorAsset)).decimals();

    operatorAdmin = cfg.operatorAdmin;
    strategySigner = cfg.strategySigner;
    riskAdmin = cfg.riskAdmin;
    riskSigner = cfg.riskSigner;
    guardian = cfg.guardian;
    feeRecipient = cfg.feeRecipient;

    tradingEpoch = 1;
    nextEpochId = 1;
    lastFeeCheckpoint = block.timestamp;

    cfg.settlementAsset.forceApprove(cfg.permit2, type(uint256).max);
    cfg.corridorAsset.forceApprove(cfg.permit2, type(uint256).max);
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
    if (block.timestamp >= epoch.cutoff) revert VaultErrors.EpochNotOpen();

    _pullExact(settlementAsset, owner, assets);
    pendingSettlement += assets;
    epoch.assets += assets;
    requestUnits[controller][requestId] += assets;

    emit DepositRequest(controller, owner, requestId, msg.sender, assets);
  }

  /// @inheritdoc IOperatorVault
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
    Epoch storage epoch = epochs[epochId];
    if (!epoch.isDeposit || epoch.state != EpochState.Closed) revert VaultErrors.EpochNotClosed();
    if (epoch.assets == 0) {
      epoch.state = EpochState.Processed;
      emit DepositEpochProcessed(epochId, 0, 0, attestation.corridorAssetPrice);
      return;
    }

    uint256 price = VaultPolicy.verifyAttestation(attestation, signature, epochId, address(this), riskSigner);
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
  function voidDepositEpoch(uint256 epochId) external override {
    Epoch storage epoch = epochs[epochId];
    if (!epoch.isDeposit || epoch.state != EpochState.Closed) revert VaultErrors.EpochNotClosed();
    if (!_durationElapsed(epoch.closedAt, valuationTimeout)) revert VaultErrors.TimeoutNotReached();
    epoch.state = EpochState.Voided;
    emit DepositEpochVoided(epochId);
  }

  /*//////////////////////////////////////////////////////////////
                             REDEMPTIONS
  //////////////////////////////////////////////////////////////*/

  /// @inheritdoc IOperatorVault
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
    Epoch storage epoch = epochs[epochId];
    if (epoch.isDeposit || epoch.state != EpochState.Closed) revert VaultErrors.EpochNotClosed();

    uint256 price = VaultPolicy.verifyAttestation(attestation, signature, epochId, address(this), riskSigner);
    _checkpointFee();

    uint256 supply = totalSupply();
    (uint256 conversionNav, uint256 freeS, uint256 freeC) = _requireLiveNav(attestation, price);
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
    Epoch storage epoch = epochs[epochId];
    if (epoch.isDeposit || epoch.state != EpochState.Closed) revert VaultErrors.EpochNotClosed();
    if (!_durationElapsed(epoch.closedAt, inKindExitTimeout)) revert VaultErrors.TimeoutNotReached();

    uint256 price = VaultPolicy.verifyAttestation(attestation, signature, epochId, address(this), riskSigner);
    _checkpointFee();
    uint256 supply = totalSupply();
    (, uint256 freeS, uint256 freeC) = _requireLiveNav(attestation, price);

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
  ///      unattested surplus.
  function settleRedeemEmergencyInKind(uint256 epochId) external override nonReentrant {
    if (!paused) revert VaultErrors.PauseRequired();
    Epoch storage epoch = epochs[epochId];
    if (epoch.isDeposit || epoch.state != EpochState.Closed) revert VaultErrors.EpochNotClosed();
    if (!_durationElapsed(epoch.closedAt, emergencyExitTimeout)) revert VaultErrors.TimeoutNotReached();

    _checkpointFee();
    uint256 supply = totalSupply();
    uint256 freeS = _freeSettlement();
    uint256 freeC = _freeCorridor();

    uint256 shares = epoch.assets;
    uint256 settlementOut = shares == 0 ? 0 : Math.mulDiv(freeS, shares, supply);
    uint256 corridorOut = shares == 0 ? 0 : Math.mulDiv(freeC, shares, supply);
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

    if (epoch.isDeposit && epoch.state == EpochState.Processed) {
      sharesOut = VaultLib.proRataWithResidue(units, remaining, epoch.shares);
      epoch.shares -= sharesOut;
      _transfer(address(this), receiver, sharesOut);
    } else {
      settlementOut = VaultLib.proRataWithResidue(units, remaining, epoch.remainingSettlement);
      corridorOut = VaultLib.proRataWithResidue(units, remaining, epoch.remainingCorridor);
      reservedSettlement -= settlementOut;
      reservedCorridor -= corridorOut;
      epoch.remainingSettlement -= settlementOut;
      epoch.remainingCorridor -= corridorOut;
      if (settlementOut > 0) settlementAsset.safeTransfer(receiver, settlementOut);
      if (corridorOut > 0) corridorAsset.safeTransfer(receiver, corridorOut);
    }

    epoch.remainingUnits -= units;
    emit Claimed(controller, receiver, requestId, sharesOut, settlementOut, corridorOut);
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
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    if (next == riskSigner || next == pendingRiskSigner) revert VaultErrors.InvalidParams();
    address previous = strategySigner;
    strategySigner = next;
    _bumpTradingEpoch();
    emit StrategySignerRotated(previous, next, tradingEpoch);
  }

  function proposeRiskSigner(address next) external onlyRiskAdmin {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    if (next == strategySigner) revert VaultErrors.InvalidParams();
    pendingRiskSigner = next;
    pendingRiskSignerAt = block.timestamp + riskSignerDelay;
    emit RiskSignerProposed(next, pendingRiskSignerAt);
  }

  function acceptRiskSigner() external {
    if (pendingRiskSigner == address(0)) revert VaultErrors.InvalidParams();
    if (pendingRiskSigner == strategySigner) revert VaultErrors.InvalidParams();
    if (block.timestamp < pendingRiskSignerAt) revert VaultErrors.RotationDelayPending();
    address previous = riskSigner;
    address next = pendingRiskSigner;
    riskSigner = next;
    pendingRiskSigner = address(0);
    pendingRiskSignerAt = 0;
    _bumpTradingEpoch();
    emit RiskSignerRotated(previous, next, tradingEpoch);
  }

  function transferOperatorAdmin(address next) external onlyOperatorAdmin {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    address previous = operatorAdmin;
    if (next == previous) revert VaultErrors.InvalidParams();
    IOperatorVaultFactory(factory).rekeyOperator(
      previous, next, address(settlementAsset), address(corridorAsset)
    );
    operatorAdmin = next;
    emit OperatorAdminTransferred(previous, next);
  }

  function transferRiskAdmin(address next) external onlyRiskAdmin {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    pendingRiskSigner = address(0);
    pendingRiskSignerAt = 0;
    emit RiskAdminTransferred(riskAdmin, next);
    riskAdmin = next;
  }

  /// @inheritdoc IOperatorVault
  function sweepToken(address token, address to) external override onlyGuardian {
    if (to == address(0)) revert VaultErrors.ZeroAddress();
    if (token == address(this) || token == address(settlementAsset) || token == address(corridorAsset)) {
      revert VaultErrors.InvalidPair();
    }
    uint256 amount = IERC20(token).balanceOf(address(this));
    if (amount == 0) revert VaultErrors.ZeroAmount();
    IERC20(token).safeTransfer(to, amount);
    emit TokenSwept(token, to, amount);
  }

  /// @inheritdoc IOperatorVault
  function sweepETH(address payable to) external override onlyGuardian {
    if (to == address(0)) revert VaultErrors.ZeroAddress();
    if (to == address(this)) revert VaultErrors.InvalidParams();
    uint256 amount = address(this).balance;
    if (amount == 0) revert VaultErrors.ZeroAmount();
    Address.sendValue(to, amount);
    emit ETHSwept(to, amount);
  }

  function setGuardian(address next) external onlyOperatorAdmin {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    emit GuardianUpdated(guardian, next);
    guardian = next;
  }

  function setFeeRecipient(address next) external onlyOperatorAdmin nonReentrant {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    _checkpointFee();
    emit FeeRecipientUpdated(feeRecipient, next);
    feeRecipient = next;
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

  /// @inheritdoc IOperatorVault
  function closeOnly() public view override returns (bool) {
    return closedRedeemEpochId != 0;
  }

  /// @inheritdoc IOperatorVault
  function freeSettlement() public view override returns (uint256) {
    return _freeSettlement();
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
    if (id != 0 && epochs[id].state == EpochState.Open) return id;
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
      remainingCorridor: 0
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
    _mint(feeRecipient, shares);
    emit FeeAccrued(feeRecipient, shares, elapsed);
  }

  function _durationElapsed(uint256 startedAt, uint256 duration) private view returns (bool) {
    return startedAt <= block.timestamp && block.timestamp - startedAt >= duration;
  }

  function _bumpTradingEpoch() private {
    unchecked {
      ++tradingEpoch;
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

  function _freeSettlement() private view returns (uint256) {
    return settlementAsset.balanceOf(address(this)) - pendingSettlement - reservedSettlement;
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
