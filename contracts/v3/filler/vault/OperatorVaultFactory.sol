// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IOperatorVaultFactory } from "./interfaces/IOperatorVaultFactory.sol";
import { OperatorVault } from "./OperatorVault.sol";
import { VaultErrors } from "./libraries/VaultErrors.sol";
import { VaultTypes } from "./libraries/VaultTypes.sol";

/**
 * @title OperatorVaultFactory
 * @notice Deploys immutable OperatorVault bytecode. One vault per
 *         (operatorAdmin, settlement, corridor, version) tuple. Holds no
 *         assets and has no upgrade authority over deployed vaults.
 */
contract OperatorVaultFactory is IOperatorVaultFactory {
  uint256 public constant VERSION = 1;

  address public immutable reactor;
  address public immutable permit2;
  address public immutable preferredFillerValidation;

  mapping(bytes32 => address) private _vaultOf;
  mapping(address => bool) public override isVault;

  event VaultDeployed(
    address indexed vault,
    address indexed operatorAdmin,
    address indexed settlementAsset,
    address corridorAsset,
    address strategySigner,
    uint256 version
  );
  event VaultRekeyed(
    address indexed vault,
    address indexed previousAdmin,
    address indexed newAdmin,
    address settlementAsset,
    address corridorAsset
  );

  constructor(address reactor_, address permit2_, address preferredFillerValidation_) {
    if (reactor_ == address(0) || permit2_ == address(0) || preferredFillerValidation_ == address(0)) {
      revert VaultErrors.ZeroAddress();
    }
    reactor = reactor_;
    permit2 = permit2_;
    preferredFillerValidation = preferredFillerValidation_;
  }

  /// @inheritdoc IOperatorVaultFactory
  function deployVault(VaultTypes.VaultInit calldata init) external returns (address vault) {
    if (msg.sender != init.operatorAdmin) revert VaultErrors.NotAuthorized();
    bytes32 key = _key(init.operatorAdmin, address(init.settlementAsset), address(init.corridorAsset));
    if (_vaultOf[key] != address(0)) revert VaultErrors.DuplicateVault();

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
      inKindExitTimeout: init.inKindExitTimeout,
      emergencyExitTimeout: init.emergencyExitTimeout,
      valuationTimeout: init.valuationTimeout,
      managementFeeWad: init.managementFeeWad,
      riskSignerDelay: init.riskSignerDelay,
      minDepositAssets: init.minDepositAssets,
      minRedeemShares: init.minRedeemShares,
      version: VERSION
    });

    vault = address(new OperatorVault(cfg));
    _vaultOf[key] = vault;
    isVault[vault] = true;

    emit VaultDeployed(
      vault,
      init.operatorAdmin,
      address(init.settlementAsset),
      address(init.corridorAsset),
      init.strategySigner,
      VERSION
    );
  }

  /// @inheritdoc IOperatorVaultFactory
  function vaultOf(address operatorAdmin, address settlementAsset, address corridorAsset)
    external
    view
    returns (address)
  {
    return _vaultOf[_key(operatorAdmin, settlementAsset, corridorAsset)];
  }

  /// @inheritdoc IOperatorVaultFactory
  function rekeyOperator(
    address fromAdmin,
    address toAdmin,
    address settlementAsset,
    address corridorAsset
  ) external {
    if (!isVault[msg.sender]) revert VaultErrors.NotAuthorized();
    if (toAdmin == address(0) || fromAdmin == toAdmin) revert VaultErrors.InvalidParams();
    bytes32 oldKey = _key(fromAdmin, settlementAsset, corridorAsset);
    bytes32 newKey = _key(toAdmin, settlementAsset, corridorAsset);
    if (_vaultOf[oldKey] != msg.sender) revert VaultErrors.NotAuthorized();
    if (_vaultOf[newKey] != address(0)) revert VaultErrors.DuplicateVault();
    delete _vaultOf[oldKey];
    _vaultOf[newKey] = msg.sender;
    emit VaultRekeyed(msg.sender, fromAdmin, toAdmin, settlementAsset, corridorAsset);
  }

  function _key(address operatorAdmin, address settlementAsset, address corridorAsset)
    private
    pure
    returns (bytes32)
  {
    return keccak256(abi.encode(operatorAdmin, settlementAsset, corridorAsset, VERSION));
  }
}
