// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRecvHook {
  function onReceive(address from, uint256 amount) external;
}

/// @notice ERC-20 that calls a code-bearing recipient back after a transfer, the
///         way ERC-777 / ERC-1363-style tokens do. A recipient without the hook is
///         ignored, so the vault itself can still hold and receive it.
contract RecvHookERC20Mock is ERC20 {
  uint8 private immutable _decimals;

  constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
    _decimals = decimals_;
  }

  function decimals() public view override returns (uint8) {
    return _decimals;
  }

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  function transfer(address to, uint256 value) public override returns (bool) {
    bool ok = super.transfer(to, value);
    _notify(to, value);
    return ok;
  }

  function transferFrom(address from, address to, uint256 value) public override returns (bool) {
    bool ok = super.transferFrom(from, to, value);
    _notify(to, value);
    return ok;
  }

  function _notify(address to, uint256 value) private {
    if (to.code.length == 0 || value == 0) return;
    try IRecvHook(to).onReceive(msg.sender, value) {} catch {}
  }
}

interface IClaimTarget {
  function freeCorridor() external view returns (uint256);
  function quotableCorridor() external view returns (uint256);
  function reservedCorridor() external view returns (uint256);
  function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
  function requestRedeem(uint256 shares, address controller, address owner) external returns (uint256);
  function claim(uint256 requestId, address controller, address receiver) external;
}

interface IOrderReactor {
  struct SignedOrder {
    bytes order;
    bytes sig;
  }

  function execute(SignedOrder calldata order) external payable;
}

/// @notice An LP contract that redeems, claims, and from inside the settlement
///         payout callback records the vault's inventory views and tries to fill
///         a pre-signed order against the vault.
contract ClaimReentryProbe {
  IClaimTarget public vault;
  address public reactor;
  bytes public armedOrder;
  bytes public armedSig;
  bytes32 public armedHash;
  bool public armed;
  bool public entered;

  uint256 public seenFree;
  uint256 public seenQuotable;
  uint256 public seenReserved;
  bytes4 public seenMagic;
  bool public filled;

  function init(address vault_, address reactor_) external {
    vault = IClaimTarget(vault_);
    reactor = reactor_;
  }

  function arm(bytes calldata order, bytes calldata sig, bytes32 hash) external {
    armedOrder = order;
    armedSig = sig;
    armedHash = hash;
    armed = true;
  }

  function approveToken(address token, address spender) external {
    IERC20(token).approve(spender, type(uint256).max);
  }

  function requestRedeem(uint256 shares) external returns (uint256) {
    return vault.requestRedeem(shares, address(this), address(this));
  }

  function claim(uint256 requestId) external {
    vault.claim(requestId, address(this), address(this));
  }

  function onReceive(address, uint256) external {
    if (!armed || entered) return;
    entered = true;
    seenFree = vault.freeCorridor();
    seenQuotable = vault.quotableCorridor();
    seenReserved = vault.reservedCorridor();
    seenMagic = vault.isValidSignature(armedHash, armedSig);
    try IOrderReactor(reactor).execute(IOrderReactor.SignedOrder({ order: armedOrder, sig: armedSig })) {
      filled = true;
    } catch {}
  }
}
