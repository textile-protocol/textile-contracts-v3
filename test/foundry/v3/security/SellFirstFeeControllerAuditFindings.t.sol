// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {SellFirstFeeController} from "../../../../contracts/v3/filler/SellFirstFeeController.sol";
import {OutputToken, ResolvedOrder} from "../../../../contracts/v3/filler/vendor/uniswapx/base/ReactorStructs.sol";

contract SellFirstFeeControllerAuditFindingsTest is Test {
    address internal constant TOKEN = address(0xC011);
    address internal constant RECIPIENT = address(0xFEE);
    address internal constant OPERATOR = address(0x0A11CE);

    SellFirstFeeController internal controller;

    function setUp() public {
        controller = new SellFirstFeeController(RECIPIENT, 5);
    }

    function testAuditFixed_DustOutputCannotExecuteFeeFree() public {
        ResolvedOrder memory order = _order(TOKEN, 1_999);

        vm.expectRevert(abi.encodeWithSelector(SellFirstFeeController.FeeRoundsToZero.selector, TOKEN, 1_999));
        controller.getFeeOutputs(order);
    }

    function testAuditFixed_MinimumFeeableOutputPaysOneAtomicUnit() public view {
        ResolvedOrder memory order = _order(TOKEN, 2_000);

        OutputToken[] memory fees = controller.getFeeOutputs(order);

        assertEq(fees.length, 1, "fee output count");
        assertEq(fees[0].token, TOKEN, "fee token");
        assertEq(fees[0].amount, 1, "minimum fee");
        assertEq(fees[0].recipient, RECIPIENT, "fee recipient");
    }

    function testAuditFixed_DuplicateTokenOutputsAggregateBeforeDustCheck() public view {
        ResolvedOrder memory order;
        order.outputs = new OutputToken[](2);
        order.outputs[0] = OutputToken({token: TOKEN, amount: 1_000, recipient: OPERATOR});
        order.outputs[1] = OutputToken({token: TOKEN, amount: 1_000, recipient: OPERATOR});

        OutputToken[] memory fees = controller.getFeeOutputs(order);

        assertEq(fees.length, 1, "fee output count");
        assertEq(fees[0].amount, 1, "aggregated minimum fee");
    }

    function _order(address token, uint256 amount) internal pure returns (ResolvedOrder memory order) {
        order.outputs = new OutputToken[](1);
        order.outputs[0] = OutputToken({token: token, amount: amount, recipient: OPERATOR});
    }
}
