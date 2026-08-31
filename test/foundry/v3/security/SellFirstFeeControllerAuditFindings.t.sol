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

    /// @dev Supersedes the report-5 I-02 revert behaviour: OperatorVault
    ///      audit L-05 flagged the revert as a hot-path liveness footgun, so a
    ///      zero-rounding fee now skips the fee leg. Fee integrity holds
    ///      because fees are computed on the merged per-token total (see
    ///      testAuditFixed_DuplicateTokenOutputsAggregateBeforeDustCheck).
    function testAuditFixed_DustOutputSkipsFeeLeg() public view {
        ResolvedOrder memory order = _order(TOKEN, 1_999);

        OutputToken[] memory fees = controller.getFeeOutputs(order);

        assertEq(fees.length, 0, "dust output must settle with no fee leg");
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
