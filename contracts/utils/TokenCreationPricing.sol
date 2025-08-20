// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import { ITokenCreationPricing } from '../interfaces/ITokenCreationPricing.sol';
import { HTS } from '../hedera/HTS.sol';

contract TokenCreationPricing is ITokenCreationPricing {
    // uint256(keccak256('TokenCreationPricing.Slot')) - 1
    uint256 internal constant TOKEN_CREATION_PRICING_SLOT = 0xb92579529e766822ba0a44394069682b56cba9d6058dc6334ef7fe967101807d;

    address public immutable whbarAddress;

    struct TokenCreationPricingStorage {
        uint256 tokenCreationPrice;
    }

    constructor(address whbarAddress_) {
        if (whbarAddress_ == address(0)) revert InvalidWhbarAddress();
        whbarAddress = whbarAddress_;
    }

    function _setTokenCreationPrice(uint256 price) internal {
        _tokenCreationPricingStorage().tokenCreationPrice = price;
    }

    /**
     * @notice Returns the token creation price in tinycents
     * @return price The token creation price in tinycents
     */
    function tokenCreationPrice() public view returns (uint256 price) {
        price = _tokenCreationPricingStorage().tokenCreationPrice;
    }

    /**
     * @notice Returns the token creation price in tinybars.
     * @return price The token creation price in tinybars.
     */
    function tokenCreationPriceTinybars() public returns (uint256 price) {
        uint256 priceTinycents = _tokenCreationPricingStorage().tokenCreationPrice;

        // Add 1 tinybar to ensure we meet the minimum value after rounding from
        // USD → HBAR (avoids underpayment due to truncation)
        price = HTS.tinycentsToTinybars(priceTinycents) + 1;
    }

    /**
     * @notice Gets the specific storage location for preventing upgrade collisions
     * @return slot containing the storage struct
     */
    function _tokenCreationPricingStorage() private pure returns (TokenCreationPricingStorage storage slot) {
        assembly {
            slot.slot := TOKEN_CREATION_PRICING_SLOT
        }
    }
}
