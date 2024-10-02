// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import { IInterchainTokenDeployer } from '../interfaces/IInterchainTokenDeployer.sol';

import { HTS, IHederaTokenService } from '../hedera/HTS.sol';

/**
 * @title InterchainTokenDeployer
 * @notice This contract is used to deploy new instances of the InterchainTokenProxy contract.
 */
contract InterchainTokenDeployer is IInterchainTokenDeployer {
    error TokenIdZero();
    error TokenNameEmpty();
    error TokenSymbolEmpty();

    function implementationAddress() public pure returns (address) {
        return address(0);
    }

    /**
     * @notice Deploys a new instance of the InterchainTokenProxy contract.
     * @param tokenId TokenId for the token.
     * @param minter Address of the minter.
     * @param name Name of the token.
     * @param symbol Symbol of the token.
     * @param decimals Decimals of the token.
     * @return tokenAddress Address of the deployed token.
     */
    function deployInterchainToken(
        bytes32,
        bytes32 tokenId,
        address minter,
        string calldata name,
        string calldata symbol,
        uint8 decimals
    ) external returns (address tokenAddress) {
        // TODO(hedera) check if we can use salt, to prevent redeployments

        if (tokenId == bytes32(0)) revert TokenIdZero();
        if (bytes(name).length == 0) revert TokenNameEmpty();
        if (bytes(symbol).length == 0) revert TokenSymbolEmpty();

        IHederaTokenService.HederaToken memory token;
        token.name = name;
        token.symbol = symbol;
        token.treasury = minter;

        // Since ITS uses delegatecall `this` would refer to the ITS contract
        // Alternatively ITS address can be passed as an argument
        // but it will change the contract interface
        address its = address(this);

        // Set the token service as a minter to allow it to mint and burn tokens.
        // Also add the provided address as a minter, if set.
        IHederaTokenService.TokenKey[] memory tokenKeys = new IHederaTokenService.TokenKey[](2);

        // Define the supply keys - minters
        IHederaTokenService.KeyValue memory supplyKeyITS = IHederaTokenService.KeyValue({
            inheritAccountKey: false,
            contractId: its,
            ed25519: '',
            ECDSA_secp256k1: '',
            delegatableContractId: address(0)
        });
        tokenKeys[0] = IHederaTokenService.TokenKey({ keyType: HTS.SUPPLY_KEY_BIT, key: supplyKeyITS });

        if (minter != address(0)) {
            IHederaTokenService.KeyValue memory supplyKeyMinter = IHederaTokenService.KeyValue({
                inheritAccountKey: false,
                // TODO(hedera) check if contractId supports account addresses
                contractId: minter,
                ed25519: '',
                ECDSA_secp256k1: '',
                delegatableContractId: address(0)
            });
            tokenKeys[1] = IHederaTokenService.TokenKey({ keyType: HTS.SUPPLY_KEY_BIT, key: supplyKeyMinter });
        }

        token.tokenKeys = tokenKeys;

        address createdTokenAddress = HTS.createFungibleToken(token, 0, int32(uint32(decimals)));

        tokenAddress = createdTokenAddress;

        // Associate the token with the InterchainTokenService contract
        // (the deploy will be called by ITS using delegatecall)
        HTS.associateToken(its, tokenAddress);
    }

    /**
     * @notice Returns the interchain token deployment address.
     * @return tokenAddress The token address.
     */
    function deployedAddress(bytes32) external pure returns (address tokenAddress) {
        return address(0);
    }
}
