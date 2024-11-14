// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import { AddressBytes } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/libs/AddressBytes.sol';
import { Multicall } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/utils/Multicall.sol';
import { Upgradable } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/upgradable/Upgradable.sol';
import { IInterchainTokenService } from './interfaces/IInterchainTokenService.sol';
import { IInterchainTokenFactory } from './interfaces/IInterchainTokenFactory.sol';
import { ITokenManagerType } from './interfaces/ITokenManagerType.sol';
import { ITokenManager } from './interfaces/ITokenManager.sol';
import { IERC20Named } from './interfaces/IERC20Named.sol';

import { HTS, IHederaTokenService } from './hedera/HTS.sol';

/**
 * @title InterchainTokenFactory
 * @notice This contract is responsible for deploying new interchain tokens and managing their token managers.
 */
contract InterchainTokenFactory is IInterchainTokenFactory, ITokenManagerType, Multicall, Upgradable {
    using AddressBytes for address;

    /// @dev This slot contains the storage for this contract in an upgrade-compatible manner
    /// keccak256('InterchainTokenFactory.Slot') - 1;
    bytes32 internal constant INTERCHAIN_TOKEN_FACTORY_SLOT = 0xd4f5c43117c663161acfe6af3208a49856d85e586baf0f60749de2055e001465;

    bytes32 private constant CONTRACT_ID = keccak256('interchain-token-factory');
    bytes32 internal constant PREFIX_CANONICAL_TOKEN_SALT = keccak256('canonical-token-salt');
    bytes32 internal constant PREFIX_INTERCHAIN_TOKEN_SALT = keccak256('interchain-token-salt');
    bytes32 internal constant PREFIX_DEPLOY_APPROVAL = keccak256('deploy-approval');
    address private constant TOKEN_FACTORY_DEPLOYER = address(0);

    IInterchainTokenService public immutable interchainTokenService;
    bytes32 public immutable chainNameHash;

    struct DeployApproval {
        address minter;
        bytes32 tokenId;
        string destinationChain;
    }

    /// @dev Storage for this contract
    /// @param approvedDestinationMinters Mapping of approved destination minters
    struct InterchainTokenFactoryStorage {
        mapping(bytes32 => bytes32) approvedDestinationMinters;
    }

    /**
     * @notice Constructs the InterchainTokenFactory contract.
     * @param interchainTokenService_ The address of the interchain token service.
     */
    constructor(address interchainTokenService_) {
        if (interchainTokenService_ == address(0)) revert ZeroAddress();

        interchainTokenService = IInterchainTokenService(interchainTokenService_);

        chainNameHash = interchainTokenService.chainNameHash();
    }

    function _setup(bytes calldata data) internal override {}

    /**
     * @notice Getter for the contract id.
     * @return bytes32 The contract id of this contract.
     */
    function contractId() external pure returns (bytes32) {
        return CONTRACT_ID;
    }

    /**
     * @notice Calculates the salt for an interchain token.
     * @param chainNameHash_ The hash of the chain name.
     * @param deployer The address of the deployer.
     * @param salt A unique identifier to generate the salt.
     * @return tokenSalt The calculated salt for the interchain token.
     */
    function interchainTokenSalt(bytes32 chainNameHash_, address deployer, bytes32 salt) public pure returns (bytes32 tokenSalt) {
        tokenSalt = keccak256(abi.encode(PREFIX_INTERCHAIN_TOKEN_SALT, chainNameHash_, deployer, salt));
    }

    /**
     * @notice Calculates the salt for a canonical interchain token.
     * @param chainNameHash_ The hash of the chain name.
     * @param tokenAddress The address of the token.
     * @return salt The calculated salt for the interchain token.
     */
    function canonicalInterchainTokenSalt(bytes32 chainNameHash_, address tokenAddress) public pure returns (bytes32 salt) {
        salt = keccak256(abi.encode(PREFIX_CANONICAL_TOKEN_SALT, chainNameHash_, tokenAddress));
    }

    /**
     * @notice Computes the ID for an interchain token based on the deployer and a salt.
     * @param deployer The address that deployed the interchain token.
     * @param salt A unique identifier used in the deployment process.
     * @return tokenId The ID of the interchain token.
     */
    function interchainTokenId(address deployer, bytes32 salt) public view returns (bytes32 tokenId) {
        tokenId = interchainTokenService.interchainTokenId(TOKEN_FACTORY_DEPLOYER, interchainTokenSalt(chainNameHash, deployer, salt));
    }

    /**
     * @notice Computes the ID for a canonical interchain token based on its address.
     * @param tokenAddress The address of the canonical interchain token.
     * @return tokenId The ID of the canonical interchain token.
     */
    function canonicalInterchainTokenId(address tokenAddress) public view returns (bytes32 tokenId) {
        tokenId = interchainTokenService.interchainTokenId(
            TOKEN_FACTORY_DEPLOYER,
            canonicalInterchainTokenSalt(chainNameHash, tokenAddress)
        );
    }

    /**
     * @notice Retrieves the address of an interchain token based on the deployer and a salt.
     * @param deployer The address that deployed the interchain token.
     * @param salt A unique identifier used in the deployment process.
     * @return tokenAddress The address of the interchain token.
     */
    function interchainTokenAddress(address deployer, bytes32 salt) public view returns (address tokenAddress) {
        tokenAddress = interchainTokenService.registeredTokenAddress(interchainTokenId(deployer, salt));
    }

    /**
     * @notice Deploys a new interchain token with specified parameters.
     * @dev Creates a new token and optionally mints an initial amount to a specified minter.
     * This function is `payable` because non-payable functions cannot be called in a multicall that calls other `payable` functions.
     * @param salt The unique salt for deploying the token.
     * @param name The name of the token.
     * @param symbol The symbol of the token.
     * @param decimals The number of decimals for the token.
     * @param initialSupply The amount of tokens to mint initially (can be zero), allocated to the msg.sender.
     * @param minter The address to receive the minter and operator role of the token, in addition to ITS. If it is set to `address(0)`,
     * the additional minter isn't set, and can't be added later. This allows creating tokens that are managed only by ITS, reducing trust assumptions.
     * Reverts if the minter is the ITS address since it's already added as a minter.
     * @return tokenId The tokenId corresponding to the deployed InterchainToken.
     */
    function deployInterchainToken(
        bytes32 salt,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        uint256 initialSupply,
        address minter
    ) external payable returns (bytes32 tokenId) {
        address sender = msg.sender;
        salt = interchainTokenSalt(chainNameHash, sender, salt);
        bytes memory minterBytes = new bytes(0);

        if (minter != address(0)) {
            if (minter == address(interchainTokenService)) revert InvalidMinter(minter);

            minterBytes = minter.toBytes();
        }

        // HTS tokens must previously be associated with an account
        // to be able to send tokens to it. Since a new token will be created
        // it's not possible to send it right away.
        if (initialSupply != 0) {
            revert HTS.InitialSupplyUnsupported();
        }

        tokenId = _deployInterchainToken(salt, '', name, symbol, decimals, minterBytes, msg.value);
    }

    /**
     * @notice Allow the minter to approve the deployer for a remote interchain token deployment that uses a custom destinationMinter address.
     * This ensures that a token deployer can't choose the destinationMinter itself, and requires the approval of the minter to reduce trust assumptions on the deployer.
     */
    function approveDeployRemoteInterchainToken(
        address deployer,
        bytes32 salt,
        string calldata destinationChain,
        bytes calldata destinationMinter
    ) external {
        address minter = msg.sender;
        bytes32 tokenId = interchainTokenId(deployer, salt);
        address tokenAddress = interchainTokenService.registeredTokenAddress(tokenId);
        if (!interchainTokenService.isTokenMinter(tokenAddress, minter)) revert InvalidMinter(minter);

        if (bytes(interchainTokenService.trustedAddress(destinationChain)).length == 0) revert InvalidChainName();

        bytes32 approvalKey = _deployApprovalKey(DeployApproval({ minter: minter, tokenId: tokenId, destinationChain: destinationChain }));

        _interchainTokenFactoryStorage().approvedDestinationMinters[approvalKey] = keccak256(destinationMinter);

        emit DeployRemoteInterchainTokenApproval(minter, deployer, tokenId, destinationChain, destinationMinter);
    }

    /**
     * @notice Allows the minter to revoke a deployer's approval for a remote interchain token deployment that uses a custom destinationMinter address.
     */
    function revokeDeployRemoteInterchainToken(address deployer, bytes32 salt, string calldata destinationChain) external {
        address minter = msg.sender;
        bytes32 tokenId = interchainTokenId(deployer, salt);

        bytes32 approvalKey = _deployApprovalKey(DeployApproval({ minter: minter, tokenId: tokenId, destinationChain: destinationChain }));

        delete _interchainTokenFactoryStorage().approvedDestinationMinters[approvalKey];

        emit RevokedDeployRemoteInterchainTokenApproval(minter, deployer, tokenId, destinationChain);
    }

    function _deployApprovalKey(DeployApproval memory approval) internal pure returns (bytes32 key) {
        key = keccak256(abi.encode(PREFIX_DEPLOY_APPROVAL, approval));
    }

    function _useDeployApproval(DeployApproval memory approval, bytes memory destinationMinter) internal {
        bytes32 approvalKey = _deployApprovalKey(approval);

        InterchainTokenFactoryStorage storage slot = _interchainTokenFactoryStorage();

        if (slot.approvedDestinationMinters[approvalKey] != keccak256(destinationMinter)) {
            revert RemoteDeploymentNotApproved();
        }

        delete slot.approvedDestinationMinters[approvalKey];
    }

    /**
     * @notice Deploys a remote interchain token on a specified destination chain.
     * @param salt The unique salt for deploying the token.
     * @param minter The address to use as the minter of the deployed token on the destination chain. If the destination chain is not EVM,
     * then use the more generic `deployRemoteInterchainToken` function below that allows setting an arbitrary destination minter that was approved by the current minter.
     * @param destinationChain The name of the destination chain.
     * @param gasValue The amount of gas to send for the deployment.
     * @return tokenId The tokenId corresponding to the deployed InterchainToken.
     */
    function deployRemoteInterchainToken(
        bytes32 salt,
        address minter,
        string memory destinationChain,
        uint256 gasValue
    ) external payable returns (bytes32 tokenId) {
        return deployRemoteInterchainTokenWithMinter(salt, minter, destinationChain, new bytes(0), gasValue);
    }

    /**
     * @notice Deploys a remote interchain token on a specified destination chain.
     * @param salt The unique salt for deploying the token.
     * @param minter The address to receive the minter and operator role of the token, in addition to ITS. If the address is `address(0)`,
     * no additional minter is set on the token. Reverts if the minter does not have mint permission for the token.
     * @param destinationChain The name of the destination chain.
     * @param destinationMinter The minter address to set on the deployed token on the destination chain. This can be arbitrary bytes
     * since the encoding of the account is dependent on the destination chain. If this is empty, then the `minter` of the token on the current chain
     * is used as the destination minter, which makes it convenient when deploying to other EVM chains.
     * @param gasValue The amount of gas to send for the deployment.
     * @return tokenId The tokenId corresponding to the deployed InterchainToken.
     */
    function deployRemoteInterchainTokenWithMinter(
        bytes32 salt,
        address minter,
        string memory destinationChain,
        bytes memory destinationMinter,
        uint256 gasValue
    ) public payable returns (bytes32 tokenId) {
        string memory tokenName;
        string memory tokenSymbol;
        uint8 tokenDecimals;
        bytes memory minter_ = new bytes(0);

        salt = interchainTokenSalt(chainNameHash, msg.sender, salt);
        tokenId = interchainTokenService.interchainTokenId(TOKEN_FACTORY_DEPLOYER, salt);

        // Note: using registeredTokenAddress instead of interchainTokenAddress
        // since HTS token addresses aren't deterministic
        address tokenAddress = interchainTokenService.registeredTokenAddress(tokenId);
        IHederaTokenService.FungibleTokenInfo memory fTokenInfo = HTS.getFungibleTokenInfo(tokenAddress);
        tokenName = fTokenInfo.tokenInfo.token.name;
        tokenSymbol = fTokenInfo.tokenInfo.token.symbol;
        int32 decimals = fTokenInfo.decimals;
        if (decimals < 0 || decimals > int32(uint32(type(uint8).max))) {
            revert HTS.InvalidTokenDecimals();
        }
        tokenDecimals = uint8(uint32(decimals));

        if (minter != address(0)) {
            // Sanity check to prevent accidental use of the current ITS address as the destination minter
            if (minter == address(interchainTokenService)) revert InvalidMinter(minter);
            if (!interchainTokenService.isTokenMinter(tokenAddress, minter)) revert NotMinter(minter);

            if (destinationMinter.length > 0) {
                DeployApproval memory approval = DeployApproval({ minter: minter, tokenId: tokenId, destinationChain: destinationChain });
                _useDeployApproval(approval, destinationMinter);
                minter_ = destinationMinter;
            } else {
                minter_ = minter.toBytes();
            }
        } else if (destinationMinter.length > 0) {
            // If a destinationMinter is provided, then minter must not be address(0)
            revert InvalidMinter(minter);
        }

        tokenId = _deployInterchainToken(salt, destinationChain, tokenName, tokenSymbol, tokenDecimals, minter_, gasValue);
    }

    /**
     * @notice Deploys a remote interchain token on a specified destination chain.
     * This method is deprecated and will be removed in the future. Please use the above method instead.
     * @dev originalChainName is only allowed to be '', i.e the current chain.
     * Other source chains are not supported anymore to simplify ITS token deployment behaviour.
     * @param originalChainName The name of the chain where the token originally exists.
     * @param salt The unique salt for deploying the token.
     * @param minter The address to receive the minter and operator role of the token, in addition to ITS. If the address is `address(0)`,
     * no additional minter is set on the token. Reverts if the minter does not have mint permission for the token.
     * @param destinationChain The name of the destination chain.
     * @param gasValue The amount of gas to send for the deployment.
     * @return tokenId The tokenId corresponding to the deployed InterchainToken.
     */
    function deployRemoteInterchainToken(
        string calldata originalChainName,
        bytes32 salt,
        address minter,
        string memory destinationChain,
        uint256 gasValue
    ) external payable returns (bytes32 tokenId) {
        if (bytes(originalChainName).length != 0) revert NotSupported();

        tokenId = deployRemoteInterchainTokenWithMinter(salt, minter, destinationChain, new bytes(0), gasValue);
    }

    /**
     * @notice Deploys a new interchain token with specified parameters.
     * @param salt The unique salt for deploying the token.
     * @param destinationChain The name of the destination chain.
     * @param tokenName The name of the token.
     * @param tokenSymbol The symbol of the token.
     * @param tokenDecimals The number of decimals for the token.
     * @param minter The address to receive the initially minted tokens.
     * @param gasValue The amount of gas to send for the transfer.
     * @return tokenId The tokenId corresponding to the deployed InterchainToken.
     */
    function _deployInterchainToken(
        bytes32 salt,
        string memory destinationChain,
        string memory tokenName,
        string memory tokenSymbol,
        uint8 tokenDecimals,
        bytes memory minter,
        uint256 gasValue
    ) internal returns (bytes32 tokenId) {
        // slither-disable-next-line arbitrary-send-eth
        tokenId = interchainTokenService.deployInterchainToken{ value: gasValue }(
            salt,
            destinationChain,
            tokenName,
            tokenSymbol,
            tokenDecimals,
            minter,
            gasValue
        );
    }

    /**
     * @notice Registers a canonical token as an interchain token and deploys its token manager.
     * @dev This function is `payable` because non-payable functions cannot be called in a multicall that calls other `payable` functions.
     * @param tokenAddress The address of the canonical token.
     * @return tokenId The tokenId corresponding to the registered canonical token.
     */
    function registerCanonicalInterchainToken(address tokenAddress) external payable returns (bytes32 tokenId) {
        bytes memory params = abi.encode('', tokenAddress);

        bool isHTSToken = HTS.isToken(tokenAddress);
        if (isHTSToken) {
            // Check if token is supported
            if (!HTS.isTokenSupportedByITS(tokenAddress)) {
                revert HTS.TokenUnsupported();
            }
        }

        bytes32 salt = canonicalInterchainTokenSalt(chainNameHash, tokenAddress);

        tokenId = interchainTokenService.deployTokenManager(salt, '', TokenManagerType.LOCK_UNLOCK, params, 0);
    }

    /**
     * @notice Deploys a canonical interchain token on a remote chain.
     * @param originalTokenAddress The address of the original token on the original chain.
     * @param destinationChain The name of the chain where the token will be deployed.
     * @param gasValue The gas amount to be sent for deployment.
     * @return tokenId The tokenId corresponding to the deployed InterchainToken.
     */
    function deployRemoteCanonicalInterchainToken(
        address originalTokenAddress,
        string calldata destinationChain,
        uint256 gasValue
    ) public payable returns (bytes32 tokenId) {
        bytes32 salt;

        // This ensures that the token manager has been deployed by this address, so it's safe to trust it.
        salt = canonicalInterchainTokenSalt(chainNameHash, originalTokenAddress);
        tokenId = interchainTokenService.interchainTokenId(TOKEN_FACTORY_DEPLOYER, salt);
        address tokenAddress = interchainTokenService.registeredTokenAddress(tokenId);

        string memory tokenName;
        string memory tokenSymbol;
        uint8 tokenDecimals;
        bytes memory minter = ''; // No additional minter is set on a canonical token deployment

        bool isHTSToken = HTS.isToken(tokenAddress);
        if (isHTSToken) {
            IHederaTokenService.FungibleTokenInfo memory fTokenInfo = HTS.getFungibleTokenInfo(tokenAddress);
            tokenName = fTokenInfo.tokenInfo.token.name;
            tokenSymbol = fTokenInfo.tokenInfo.token.symbol;
            int32 decimals = fTokenInfo.decimals;
            if (decimals < 0 || decimals > int32(uint32(type(uint8).max))) {
                revert HTS.InvalidTokenDecimals();
            }
            tokenDecimals = uint8(uint32(decimals));
        } else {
            IERC20Named token = IERC20Named(tokenAddress);
            // The 3 lines below will revert if the token does not exist.
            tokenName = token.name();
            tokenSymbol = token.symbol();
            tokenDecimals = token.decimals();
        }

        tokenId = _deployInterchainToken(salt, destinationChain, tokenName, tokenSymbol, tokenDecimals, minter, gasValue);
    }

    /**
     * @notice Deploys a canonical interchain token on a remote chain.
     * This method is deprecated and will be removed in the future. Please use the above method instead.
     * @dev originalChain is only allowed to be '', i.e the current chain.
     * Other source chains are not supported anymore to simplify ITS token deployment behaviour.
     * @param originalChain The name of the chain where the token originally exists.
     * @param originalTokenAddress The address of the original token on the original chain.
     * @param destinationChain The name of the chain where the token will be deployed.
     * @param gasValue The gas amount to be sent for deployment.
     * @return tokenId The tokenId corresponding to the deployed InterchainToken.
     */
    function deployRemoteCanonicalInterchainToken(
        string calldata originalChain,
        address originalTokenAddress,
        string calldata destinationChain,
        uint256 gasValue
    ) external payable returns (bytes32 tokenId) {
        if (bytes(originalChain).length != 0) revert NotSupported();

        tokenId = deployRemoteCanonicalInterchainToken(originalTokenAddress, destinationChain, gasValue);
    }

    /**
     * \
     * |* Pure Key Getters *|
     * \*******************
     */

    /**
     * @notice Gets the specific storage location for preventing upgrade collisions
     * @return slot containing the storage struct
     */
    function _interchainTokenFactoryStorage() private pure returns (InterchainTokenFactoryStorage storage slot) {
        assembly {
            slot.slot := INTERCHAIN_TOKEN_FACTORY_SLOT
        }
    }
}
