// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ZeroDecimalsToken is ERC20 {
  constructor() ERC20("Zero", "Z") {}

  function decimals() public pure override returns (uint8) {
    return 0;
  }
}

contract HighDecimalsToken is ERC20 {
  constructor() ERC20("High", "H") {}

  function decimals() public pure override returns (uint8) {
    return 78;
  }
}

contract NoDecimalsToken {
  function transfer(address, uint256) external pure returns (bool) {
    return true;
  }
}

contract FeeOnTransferMock is ERC20 {
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

  function _update(address from, address to, uint256 value) internal override {
    if (from != address(0) && to != address(0) && value > 0) {
      super._update(from, to, value - 1);
      return;
    }
    super._update(from, to, value);
  }
}
