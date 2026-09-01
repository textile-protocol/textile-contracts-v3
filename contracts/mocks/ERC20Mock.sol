// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 Textile, Inc.
// This smart contract is part of the Textile Protocol.
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ERC20Mock is ERC20 {
  uint8 private _decimals;

  constructor(string memory name, string memory symbol, uint8 decimalsValue) ERC20(name, symbol) {
    _decimals = decimalsValue;
  }

  function mint(address account, uint256 amount) external {
    _mint(account, amount);
  }

  function burn(address account, uint256 amount) external {
    _burn(account, amount);
  }

  function decimals() public view virtual override returns (uint8) {
    return _decimals;
  }
}
