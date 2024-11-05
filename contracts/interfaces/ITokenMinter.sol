// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

/**
 * @title ITokenMinter Interface
 * @notice
 */
interface ITokenMinter {
    error MissingMinterPermission();
    error NotNativeInterchainToken();

    event TokenMinterAdded(address indexed token, address indexed account);
    event TokenMinterRemoved(address indexed token, address indexed account);

    /**
     * @notice Change the minter of the contract.
     * @dev Can only be called by the current minter.
     * @param token The address of the token.
     * @param minter The address of the new minter.
     */
    function transferTokenMintership(address token, address minter) external;

    /**
     * @notice Query if an address is a minter
     * @param token the address of the token
     * @param addr the address to query for
     * @return bool Boolean value representing whether or not the address is a minter.
     */
    function isTokenMinter(address token, address addr) external view returns (bool);

    /**
     * @notice Function to mint new tokens.
     * @dev Can only be called by the minter address.
     * Reverts if the token is not a native interchain token (Hedera Token).
     * @param token The address of the token
     * @param account The address that will receive the minted tokens.
     * @param amount The amount of tokens to mint.
     */
    function mintToken(address token, address account, uint256 amount) external;

    /**
     * @notice Function to burn tokens.
     * This contract must have been granted the allowance to transfer tokens.
     * Reverts if the token is not a native interchain token (Hedera Token).
     * @dev Can only be called by the minter address.
     * @param token The address of the token
     * @param account The address that will have its tokens burnt.
     * @param amount The amount of tokens to burn.
     */
    function burnToken(address token, address account, uint256 amount) external;
}
