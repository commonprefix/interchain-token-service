// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import { ITokenMinter } from '../interfaces/ITokenMinter.sol';

/**
 * @title TokenMinter Contract
 * @notice
 * @dev This module is used through inheritance.
 */
contract TokenMinter is ITokenMinter {
    mapping(address => mapping(address => bool)) internal tokenMinters;

    modifier onlyTokenMinter(address token) {
        if (!tokenMinters[token][msg.sender]) revert MissingMinterPermission();
        _;
    }

    /**
     * @notice Internal function that stores the new minter address in the correct storage slot.
     * @param minter The address of the new minter.
     * @param token the address of the token
     */
    function _addTokenMinter(address token, address minter) internal {
        tokenMinters[token][minter] = true;
    }

    /**
     * @notice Changes the minter of the contract.
     * @dev Can only be called by the current minter.
     * @param token the address of the token
     * @param minter The address of the new minter.
     */
    function transferTokenMintership(address token, address minter) external onlyTokenMinter(token) {
        delete tokenMinters[token][msg.sender];
        tokenMinters[token][minter] = true;
    }

    /**
     * @notice Query if an address is a minter
     * @param token the address of the token
     * @param addr the address to query for
     * @return bool Boolean value representing whether or not the address is a minter.
     */
    function isTokenMinter(address token, address addr) external view returns (bool) {
        return tokenMinters[token][addr];
    }
}
