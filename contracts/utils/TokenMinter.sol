// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import { ITokenMinter } from '../interfaces/ITokenMinter.sol';
import { HTS } from '../hedera/HTS.sol';

/**
 * @title TokenMinter Contract
 * @notice Allows custom minters to mint and burn HTS tokens via ITS. Mintership can be transferred.
 * @dev This module is used through inheritance.
 */
contract TokenMinter is ITokenMinter {
    mapping(address => mapping(address => bool)) private tokenMinters;

    /**
     * @notice This modifier is used to ensure that only a token minter can call the function.
     * @param token The address of the token
     */
    modifier onlyTokenMinter(address token) {
        if (!tokenMinters[token][msg.sender]) revert MissingMinterPermission();
        _;
    }

    /**
     * @notice Internal function that add a new minter.
     * @param minter The address of the new minter.
     * @param token The address of the token
     */
    function _addTokenMinter(address token, address minter) internal {
        tokenMinters[token][minter] = true;
    }

    /**
     * @notice Changes the minter of the contract.
     * @dev Can only be called by the current minter.
     * @param token The address of the token
     * @param minter The address of the new minter.
     */
    function transferTokenMintership(address token, address minter) external onlyTokenMinter(token) {
        delete tokenMinters[token][msg.sender];
        tokenMinters[token][minter] = true;
    }

    /**
     * @notice Query if an address is a minter
     * @param token The address of the token
     * @param addr The address to query for
     * @return bool Boolean value representing whether or not the address is a minter.
     */
    function isTokenMinter(address token, address addr) external view returns (bool) {
        return tokenMinters[token][addr];
    }

    /**
     * @notice Function to mint new tokens.
     * @dev Can only be called by the minter address.
     * Reverts if the token is not a native interchain token (Hedera Token).
     * @param token The address of the token
     * @param account The address that will receive the minted tokens.
     * @param amount The amount of tokens to mint.
     */
    function mintToken(address token, address account, uint256 amount) external onlyTokenMinter(token) {
        HTS.mintToken(token, amount);
        HTS.transferToken(token, address(this), account, amount);
    }

    /**
     * @notice Function to burn tokens.
     * This contract must have been granted the allowance to transfer tokens.
     * Reverts if the token is not a native interchain token (Hedera Token).
     * @dev Can only be called by the minter address.
     * @param token The address of the token
     * @param account The address that will have its tokens burnt.
     * @param amount The amount of tokens to burn.
     */
    function burnToken(address token, address account, uint256 amount) external onlyTokenMinter(token) {
        HTS.transferFrom(token, account, address(this), amount);
        HTS.burnToken(token, amount);
    }
}
