// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import { IInterchainTokenDeployer } from '../interfaces/IInterchainTokenDeployer.sol';

import { HTS, IHederaTokenService } from '../hedera/HTS.sol';

/**
 * @title InterchainTokenDeployer
 * @notice This contract is used to deploy new instances of the InterchainTokenProxy contract.
 */
contract InterchainTokenDeployer is IInterchainTokenDeployer {
    function implementationAddress() public pure returns (address) {
        return address(0);
    }

    /**
     * @notice Deploys a new instance of the InterchainTokenProxy contract.
     * @param tokenId TokenId for the token.
     * @param name Name of the token.
     * @param symbol Symbol of the token.
     * @param decimals Decimals of the token.
     * @return tokenAddress Address of the deployed token.
     */
    function deployInterchainToken(
        bytes32 tokenId,
        address,
        string calldata name,
        string calldata symbol,
        uint8 decimals
    ) external payable returns (address tokenAddress) {
        // Since ITS uses delegatecall `this` refers to the ITS contract
        address its = address(this);

        if (tokenId == bytes32(0)) revert TokenIdZero();
        if (bytes(name).length == 0) revert TokenNameEmpty();
        if (bytes(symbol).length == 0) revert TokenSymbolEmpty();

        IHederaTokenService.HederaToken memory token;
        token.name = name;
        token.symbol = symbol;
        token.treasury = its;

        // Set the token service as a minter to allow it to mint and burn tokens.
        // Also add the provided address as a minter, if set.
        IHederaTokenService.TokenKey[] memory tokenKeys = new IHederaTokenService.TokenKey[](1);
        // Define the supply keys - minter
        IHederaTokenService.KeyValue memory supplyKeyITS = IHederaTokenService.KeyValue({
            inheritAccountKey: false,
            contractId: its,
            ed25519: '',
            ECDSA_secp256k1: '',
            delegatableContractId: address(0)
        });
        tokenKeys[0] = IHederaTokenService.TokenKey({ keyType: HTS.SUPPLY_KEY_BIT, key: supplyKeyITS });
        token.tokenKeys = tokenKeys;

        // Set some default values for the expiry
        // NOTE: Expiry is currently disabled on Hedera
        IHederaTokenService.Expiry memory expiry = IHederaTokenService.Expiry(0, its, 8000000);
        token.expiry = expiry;

        address createdTokenAddress = HTS.createFungibleToken(token, 0, int32(uint32(decimals)));

        tokenAddress = createdTokenAddress;
    }

    /**
     * @notice Returns the interchain token deployment address.
     * @return tokenAddress The token address.
     */
    function deployedAddress(bytes32) external pure returns (address tokenAddress) {
        return address(0);
    }
}
