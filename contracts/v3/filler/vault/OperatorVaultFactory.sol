// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

import { IOperatorVaultFactory } from "./interfaces/IOperatorVaultFactory.sol";
import { VaultDeployer } from "./libraries/VaultDeployer.sol";
import { VaultErrors } from "./libraries/VaultErrors.sol";
import { VaultTypes } from "./libraries/VaultTypes.sol";

/**
 * @title OperatorVaultFactory
 * @notice Deploys immutable OperatorVaults. An operator may hold any number of vaults for the
 *         same (settlement, corridor) pair; the factory indexes them per (operatorAdmin,
 *         settlement, corridor, version) in deployment order. Holds no assets and has no
 *         authority over deployed vaults.
 */
contract OperatorVaultFactory is IOperatorVaultFactory {
  uint256 public constant VERSION = 1;
  uint256 public constant MAX_NAME_BYTES = 64;
  uint256 public constant MAX_SYMBOL_BYTES = 16;
  /// @notice The protocol may take at most half of either fee leg.
  uint256 public constant MAX_PROTOCOL_FEE_SHARE_WAD = 5e17;

  address public immutable reactor;
  address public immutable permit2;
  address public immutable preferredFillerValidation;
  /// @notice Yield adapter implementation cloned per vault. Zero = yield cannot be enabled.
  address public immutable yieldAdapterImplementation;
  /// @notice Where Textile's cut of every vault's fee accruals is minted. Immutable, so no
  ///         key can redirect fees on a live vault.
  address public immutable override protocolFeeRecipient;

  /// @notice Textile's cut of each fee leg, fixed per vault at deploy.
  struct ProtocolTerms {
    uint128 managementShareWad;
    uint128 performanceShareWad;
  }
  mapping(address => ProtocolTerms) private _protocolTerms;

  /// @dev Vaults per (operatorAdmin, settlement, corridor, VERSION), oldest first.
  mapping(bytes32 => address[]) private _vaultsOf;
  mapping(address => bool) public override isVault;

  event VaultDeployed(
    address indexed vault,
    address indexed operatorAdmin,
    address indexed settlementAsset,
    address corridorAsset,
    address strategySigner,
    uint256 version,
    string name,
    string symbol
  );
  event ProtocolTermsSet(address indexed vault, uint256 managementShareWad, uint256 performanceShareWad);
  event VaultRekeyed(
    address indexed vault,
    address indexed previousAdmin,
    address indexed newAdmin,
    address settlementAsset,
    address corridorAsset
  );

  constructor(
    address reactor_,
    address permit2_,
    address preferredFillerValidation_,
    address yieldAdapterImplementation_,
    address protocolFeeRecipient_
  ) {
    if (
      reactor_ == address(0) || permit2_ == address(0) || preferredFillerValidation_ == address(0)
        || protocolFeeRecipient_ == address(0)
    ) revert VaultErrors.ZeroAddress();
    reactor = reactor_;
    permit2 = permit2_;
    preferredFillerValidation = preferredFillerValidation_;
    yieldAdapterImplementation = yieldAdapterImplementation_;
    protocolFeeRecipient = protocolFeeRecipient_;
  }

  /// @inheritdoc IOperatorVaultFactory
  function protocolFeeFor(address vault)
    external
    view
    returns (address recipient, uint256 managementShareWad, uint256 performanceShareWad)
  {
    ProtocolTerms storage terms = _protocolTerms[vault];
    return (protocolFeeRecipient, terms.managementShareWad, terms.performanceShareWad);
  }

  /// @inheritdoc IOperatorVaultFactory
  function deployVault(VaultTypes.VaultInit calldata init) external returns (address vault) {
    if (msg.sender != init.operatorAdmin) revert VaultErrors.NotAuthorized();
    _requireLabel(init.name, MAX_NAME_BYTES);
    _requireLabel(init.symbol, MAX_SYMBOL_BYTES);
    if (
      init.protocolManagementShareWad > MAX_PROTOCOL_FEE_SHARE_WAD
        || init.protocolPerformanceShareWad > MAX_PROTOCOL_FEE_SHARE_WAD
    ) revert VaultErrors.InvalidParams();
    bytes32 key = _key(init.operatorAdmin, address(init.settlementAsset), address(init.corridorAsset));

    // The vault constructor binds the clone to itself, or reverts.
    address adapter;
    if (init.enableYield) {
      if (yieldAdapterImplementation == address(0)) revert VaultErrors.YieldNotSupported();
      adapter = Clones.clone(yieldAdapterImplementation);
    }

    VaultTypes.VaultConfig memory cfg = VaultTypes.VaultConfig({
      settlementAsset: init.settlementAsset,
      corridorAsset: init.corridorAsset,
      reactor: reactor,
      permit2: permit2,
      preferredFillerValidation: preferredFillerValidation,
      operatorAdmin: init.operatorAdmin,
      strategySigner: init.strategySigner,
      riskAdmin: init.riskAdmin,
      riskSigner: init.riskSigner,
      guardian: init.guardian,
      feeRecipient: init.feeRecipient,
      maxOrderInputSettlement: init.maxOrderInputSettlement,
      maxOrderInputCorridor: init.maxOrderInputCorridor,
      minReserveSettlement: init.minReserveSettlement,
      minReserveCorridor: init.minReserveCorridor,
      maxOrderLifetime: init.maxOrderLifetime,
      depositEpochDuration: init.depositEpochDuration,
      redemptionEpochDuration: init.redemptionEpochDuration,
      redemptionCloseCooldown: init.redemptionCloseCooldown,
      emergencyExitTimeout: init.emergencyExitTimeout,
      valuationTimeout: init.valuationTimeout,
      managementFeeWad: init.managementFeeWad,
      performanceFeeWad: init.performanceFeeWad,
      riskSignerDelay: init.riskSignerDelay,
      minDepositAssets: init.minDepositAssets,
      minDepositCorridor: init.minDepositCorridor,
      minRedeemShares: init.minRedeemShares,
      yieldAdapter: adapter,
      minLiquidSettlement: init.minLiquidSettlement,
      perfFloorEnabled: init.perfFloorEnabled
    });

    vault = VaultDeployer.deploy(cfg, init.name, init.symbol);
    _vaultsOf[key].push(vault);
    isVault[vault] = true;
    // Both fit uint128: capped at 5e17 above.
    _protocolTerms[vault] = ProtocolTerms(
      uint128(init.protocolManagementShareWad), uint128(init.protocolPerformanceShareWad)
    );

    emit VaultDeployed(
      vault,
      init.operatorAdmin,
      address(init.settlementAsset),
      address(init.corridorAsset),
      init.strategySigner,
      VERSION,
      init.name,
      init.symbol
    );
    // After VaultDeployed: the subgraph creates the vault on that event and fills the terms in on this one.
    emit ProtocolTermsSet(vault, init.protocolManagementShareWad, init.protocolPerformanceShareWad);
  }

  /// @inheritdoc IOperatorVaultFactory
  function vaultOf(address operatorAdmin, address settlementAsset, address corridorAsset)
    external
    view
    returns (address)
  {
    address[] storage vaults = _vaultsOf[_key(operatorAdmin, settlementAsset, corridorAsset)];
    return vaults.length == 0 ? address(0) : vaults[vaults.length - 1];
  }

  /// @inheritdoc IOperatorVaultFactory
  function vaultsOf(address operatorAdmin, address settlementAsset, address corridorAsset)
    external
    view
    returns (address[] memory)
  {
    return _vaultsOf[_key(operatorAdmin, settlementAsset, corridorAsset)];
  }

  /// @inheritdoc IOperatorVaultFactory
  function vaultCountOf(address operatorAdmin, address settlementAsset, address corridorAsset)
    external
    view
    returns (uint256)
  {
    return _vaultsOf[_key(operatorAdmin, settlementAsset, corridorAsset)].length;
  }

  /// @inheritdoc IOperatorVaultFactory
  /// @dev Only a vault this factory deployed may call, so the list walked is its own operator's,
  ///      bounded by what that operator paid to deploy.
  function rekeyOperator(
    address fromAdmin,
    address toAdmin,
    address settlementAsset,
    address corridorAsset
  ) external {
    if (!isVault[msg.sender]) revert VaultErrors.NotAuthorized();
    if (toAdmin == address(0) || fromAdmin == toAdmin) revert VaultErrors.InvalidParams();
    address[] storage from = _vaultsOf[_key(fromAdmin, settlementAsset, corridorAsset)];
    uint256 index = _indexOf(from, msg.sender);

    // Order-preserving removal, not swap-and-pop: `vaultOf` must keep answering with the newest vault.
    for (uint256 i = index; i + 1 < from.length; ++i) {
      from[i] = from[i + 1];
    }
    from.pop();

    // No duplicate check on the destination: holding several vaults for one pair is allowed.
    _vaultsOf[_key(toAdmin, settlementAsset, corridorAsset)].push(msg.sender);
    emit VaultRekeyed(msg.sender, fromAdmin, toAdmin, settlementAsset, corridorAsset);
  }

  /// @dev The revert is unreachable from a vault of ours (`acceptOperatorAdmin` passes the key it
  ///      was pushed under) and kept on purpose: it stops any caller shifting someone else's list.
  function _indexOf(address[] storage vaults, address vault) private view returns (uint256) {
    uint256 length = vaults.length;
    for (uint256 i = 0; i < length; ++i) {
      if (vaults[i] == vault) return i;
    }
    revert VaultErrors.NotAuthorized();
  }

  /// @dev Uniqueness is not enforced: the vault address is the identity, the strings are a label.
  function _requireLabel(string calldata label, uint256 maxBytes) private pure {
    uint256 length = bytes(label).length;
    if (length == 0 || length > maxBytes) revert VaultErrors.InvalidParams();
  }

  function _key(address operatorAdmin, address settlementAsset, address corridorAsset)
    private
    pure
    returns (bytes32)
  {
    return keccak256(abi.encode(operatorAdmin, settlementAsset, corridorAsset, VERSION));
  }
}
