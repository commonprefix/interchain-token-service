// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import { IERC20 } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/interfaces/IERC20.sol';
import { IAxelarGasService } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/interfaces/IAxelarGasService.sol';
import { IAxelarGateway } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/interfaces/IAxelarGateway.sol';
import { ExpressExecutorTracker } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/express/ExpressExecutorTracker.sol';
import { Upgradable } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/upgradable/Upgradable.sol';
import { AddressBytes } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/libs/AddressBytes.sol';
import { Multicall } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/utils/Multicall.sol';
import { Pausable } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/utils/Pausable.sol';
import { InterchainAddressTracker } from '@axelar-network/axelar-gmp-sdk-solidity/contracts/utils/InterchainAddressTracker.sol';

import { IInterchainTokenService } from './interfaces/IInterchainTokenService.sol';
import { ITokenHandler } from './interfaces/ITokenHandler.sol';
import { ITokenManagerDeployer } from './interfaces/ITokenManagerDeployer.sol';
import { IInterchainTokenDeployer } from './interfaces/IInterchainTokenDeployer.sol';
import { IInterchainTokenExecutable } from './interfaces/IInterchainTokenExecutable.sol';
import { IInterchainTokenExpressExecutable } from './interfaces/IInterchainTokenExpressExecutable.sol';
import { ITokenManager } from './interfaces/ITokenManager.sol';
import { IGatewayCaller } from './interfaces/IGatewayCaller.sol';
import { Create3AddressFixed } from './utils/Create3AddressFixed.sol';
import { Operator } from './utils/Operator.sol';
import { TokenMinter } from './utils/TokenMinter.sol';

/**
 * @title The Interchain Token Service
 * @notice This contract is responsible for facilitating interchain token transfers.
 * It (mostly) does not handle tokens, but is responsible for the messaging that needs to occur for interchain transfers to happen.
 * @dev The only storage used in this contract is for Express calls.
 * Furthermore, no ether is intended to or should be sent to this contract except as part of deploy/interchainTransfer payable methods for gas payment.
 */
contract InterchainTokenService is
    Upgradable,
    Operator,
    TokenMinter,
    Pausable,
    Multicall,
    Create3AddressFixed,
    ExpressExecutorTracker,
    InterchainAddressTracker,
    IInterchainTokenService
{
    using AddressBytes for bytes;
    using AddressBytes for address;

    /**
     * @dev There are two types of Axelar Gateways for cross-chain messaging:
     * 1. Cross-chain messaging (GMP): The Axelar Gateway allows sending cross-chain messages.
     *    This is compatible across both Amplifier and consensus chains. IAxelarGateway interface exposes this functionality.
     * 2. Cross-chain messaging with Gateway Token: The AxelarGateway on legacy consensus EVM connections supports this (via callContractWithToken)
     *    but not Amplifier chains. The gateway is cast to IAxelarGatewayWithToken when gateway tokens need to be handled.
     *    ITS deployments on Amplifier chains will revert when this functionality is used.
     */
    IAxelarGateway public immutable gateway;
    IAxelarGasService public immutable gasService;
    address public immutable interchainTokenFactory;
    bytes32 public immutable chainNameHash;

    address public immutable interchainTokenDeployer;
    address public immutable tokenManagerDeployer;

    /**
     * @dev Token manager implementation addresses
     */
    address public immutable tokenManager;
    address public immutable tokenHandler;
    address public immutable gatewayCaller;

    bytes32 internal constant PREFIX_INTERCHAIN_TOKEN_ID = keccak256('its-interchain-token-id');
    bytes32 internal constant PREFIX_INTERCHAIN_TOKEN_SALT = keccak256('its-interchain-token-salt');

    bytes32 private constant CONTRACT_ID = keccak256('interchain-token-service');
    bytes32 private constant EXECUTE_SUCCESS = keccak256('its-execute-success');
    bytes32 private constant EXPRESS_EXECUTE_SUCCESS = keccak256('its-express-execute-success');

    /**
     * @dev The message types that are sent between InterchainTokenService on different chains.
     */
    uint256 private constant MESSAGE_TYPE_INTERCHAIN_TRANSFER = 0;
    uint256 private constant MESSAGE_TYPE_DEPLOY_INTERCHAIN_TOKEN = 1;
    uint256 private constant MESSAGE_TYPE_DEPLOY_TOKEN_MANAGER = 2;
    uint256 private constant MESSAGE_TYPE_SEND_TO_HUB = 3;
    uint256 private constant MESSAGE_TYPE_RECEIVE_FROM_HUB = 4;

    /**
     * @dev Tokens and token managers deployed via the Token Factory contract use a special deployer address.
     * This removes the dependency on the address the token factory was deployed too to be able to derive the same tokenId.
     */
    address internal constant TOKEN_FACTORY_DEPLOYER = address(0);

    /**
     * @dev Latest version of metadata that's supported.
     */
    uint32 internal constant LATEST_METADATA_VERSION = 1;

    /**
     * @dev Chain name where ITS Hub exists. This is used for routing ITS calls via ITS hub.
     * This is set as a constant, since the ITS Hub will exist on Axelar.
     */
    string internal constant ITS_HUB_CHAIN_NAME = 'axelar';
    bytes32 internal constant ITS_HUB_CHAIN_NAME_HASH = keccak256(abi.encodePacked(ITS_HUB_CHAIN_NAME));

    /**
     * @dev Special identifier that the trusted address for a chain should be set to, which indicates if the ITS call
     * for that chain should be routed via the ITS hub.
     */
    string internal constant ITS_HUB_ROUTING_IDENTIFIER = 'hub';
    bytes32 internal constant ITS_HUB_ROUTING_IDENTIFIER_HASH = keccak256(abi.encodePacked(ITS_HUB_ROUTING_IDENTIFIER));

    /**
     * @notice Constructor for the Interchain Token Service.
     * @dev All of the variables passed here are stored as immutable variables.
     * @param tokenManagerDeployer_ The address of the TokenManagerDeployer.
     * @param interchainTokenDeployer_ The address of the InterchainTokenDeployer.
     * @param gateway_ The address of the AxelarGateway.
     * @param gasService_ The address of the AxelarGasService.
     * @param interchainTokenFactory_ The address of the InterchainTokenFactory.
     * @param chainName_ The name of the chain that this contract is deployed on.
     * @param tokenManagerImplementation_ The tokenManager implementation.
     * @param tokenHandler_ The tokenHandler implementation.
     * @param gatewayCaller_ The gatewayCaller implementation.
     */
    constructor(
        address tokenManagerDeployer_,
        address interchainTokenDeployer_,
        address gateway_,
        address gasService_,
        address interchainTokenFactory_,
        string memory chainName_,
        address tokenManagerImplementation_,
        address tokenHandler_,
        address gatewayCaller_
    ) {
        if (
            gasService_ == address(0) ||
            tokenManagerDeployer_ == address(0) ||
            interchainTokenDeployer_ == address(0) ||
            gateway_ == address(0) ||
            interchainTokenFactory_ == address(0) ||
            tokenManagerImplementation_ == address(0) ||
            tokenHandler_ == address(0) ||
            gatewayCaller_ == address(0)
        ) revert ZeroAddress();

        gateway = IAxelarGateway(gateway_);
        gasService = IAxelarGasService(gasService_);
        tokenManagerDeployer = tokenManagerDeployer_;
        interchainTokenDeployer = interchainTokenDeployer_;
        interchainTokenFactory = interchainTokenFactory_;

        if (bytes(chainName_).length == 0) revert InvalidChainName();
        chainNameHash = keccak256(bytes(chainName_));

        tokenManager = tokenManagerImplementation_;
        tokenHandler = tokenHandler_;
        gatewayCaller = gatewayCaller_;
    }

    /**
     * \
     * MODIFIERS
     * \******
     */

    /**
     * @notice This modifier is used to ensure that only a remote InterchainTokenService can invoke the execute function.
     * @param sourceChain The source chain of the contract call.
     * @param sourceAddress The source address that the call came from.
     */
    modifier onlyRemoteService(string calldata sourceChain, string calldata sourceAddress) {
        if (!isTrustedAddress(sourceChain, sourceAddress)) revert NotRemoteService();

        _;
    }

    /**
     * \
     * GETTERS
     * \****
     */

    /**
     * @notice Getter for the contract id.
     * @return bytes32 The contract id of this contract.
     */
    function contractId() external pure returns (bytes32) {
        return CONTRACT_ID;
    }

    /**
     * @notice Calculates the address of a TokenManager from a specific tokenId.
     * @dev The TokenManager does not need to exist already.
     * @param tokenId The tokenId.
     * @return tokenManagerAddress_ The deployment address of the TokenManager.
     */
    function tokenManagerAddress(bytes32 tokenId) public view returns (address tokenManagerAddress_) {
        tokenManagerAddress_ = _create3Address(tokenId);
    }

    /**
     * @notice Returns the address of a TokenManager from a specific tokenId.
     * @dev The TokenManager needs to exist already.
     * @param tokenId The tokenId.
     * @return tokenManagerAddress_ The deployment address of the TokenManager.
     */
    function validTokenManagerAddress(bytes32 tokenId) public view returns (address tokenManagerAddress_) {
        tokenManagerAddress_ = tokenManagerAddress(tokenId);
        if (tokenManagerAddress_.code.length == 0) revert TokenManagerDoesNotExist(tokenId);
    }

    /**
     * @notice Returns the address of the token that an existing tokenManager points to.
     * @param tokenId The tokenId.
     * @return tokenAddress The address of the token.
     */
    function validTokenAddress(bytes32 tokenId) public view returns (address tokenAddress) {
        address tokenManagerAddress_ = validTokenManagerAddress(tokenId);
        tokenAddress = ITokenManager(tokenManagerAddress_).tokenAddress();
    }

    /**
     * @notice Returns the address of the interchain token associated with the given tokenId.
     * @dev The token does not need to exist.
     * @param tokenId The tokenId of the interchain token.
     * @return tokenAddress The address of the interchain token.
     */
    function interchainTokenAddress(bytes32 tokenId) public view returns (address tokenAddress) {
        tokenId = _getInterchainTokenSalt(tokenId);
        tokenAddress = _create3Address(tokenId);
    }

    /**
     * @notice Calculates the tokenId that would correspond to a link for a given deployer with a specified salt.
     * @param sender The address of the TokenManager deployer.
     * @param salt The salt that the deployer uses for the deployment.
     * @return tokenId The tokenId that the custom TokenManager would get (or has gotten).
     */
    function interchainTokenId(address sender, bytes32 salt) public pure returns (bytes32 tokenId) {
        tokenId = keccak256(abi.encode(PREFIX_INTERCHAIN_TOKEN_ID, sender, salt));
    }

    /**
     * @notice Getter function for TokenManager implementation. This will mainly be called by TokenManager proxies
     * to figure out their implementations.
     * @return tokenManagerAddress The address of the TokenManager implementation.
     */
    function tokenManagerImplementation(uint256 /*tokenManagerType*/) external view returns (address) {
        return tokenManager;
    }

    /**
     * @notice Getter function for the flow limit of an existing TokenManager with a given tokenId.
     * @param tokenId The tokenId of the TokenManager.
     * @return flowLimit_ The flow limit.
     */
    function flowLimit(bytes32 tokenId) external view returns (uint256 flowLimit_) {
        ITokenManager tokenManager_ = ITokenManager(validTokenManagerAddress(tokenId));
        flowLimit_ = tokenManager_.flowLimit();
    }

    /**
     * @notice Getter function for the flow out amount of an existing TokenManager with a given tokenId.
     * @param tokenId The tokenId of the TokenManager.
     * @return flowOutAmount_ The flow out amount.
     */
    function flowOutAmount(bytes32 tokenId) external view returns (uint256 flowOutAmount_) {
        ITokenManager tokenManager_ = ITokenManager(validTokenManagerAddress(tokenId));
        flowOutAmount_ = tokenManager_.flowOutAmount();
    }

    /**
     * @notice Getter function for the flow in amount of an existing TokenManager with a given tokenId.
     * @param tokenId The tokenId of the TokenManager.
     * @return flowInAmount_ The flow in amount.
     */
    function flowInAmount(bytes32 tokenId) external view returns (uint256 flowInAmount_) {
        ITokenManager tokenManager_ = ITokenManager(validTokenManagerAddress(tokenId));
        flowInAmount_ = tokenManager_.flowInAmount();
    }

    /**
     * \
     * USER FUNCTIONS
     * \***********
     */

    /**
     * @notice Used to deploy remote custom TokenManagers.
     * @dev At least the `gasValue` amount of native token must be passed to the function call. `gasValue` exists because this function can be
     * part of a multicall involving multiple functions that could make remote contract calls.
     * @param salt The salt to be used during deployment.
     * @param destinationChain The name of the chain to deploy the TokenManager and standardized token to.
     * @param tokenManagerType The type of token manager to be deployed. Cannot be NATIVE_INTERCHAIN_TOKEN.
     * @param params The params that will be used to initialize the TokenManager.
     * @param gasValue The amount of native tokens to be used to pay for gas for the remote deployment.
     * @return tokenId The tokenId corresponding to the deployed TokenManager.
     */
    function deployTokenManager(
        bytes32 salt,
        string calldata destinationChain,
        TokenManagerType tokenManagerType,
        bytes calldata params,
        uint256 gasValue
    ) external payable whenNotPaused returns (bytes32 tokenId) {
        // Custom token managers can't be deployed with native interchain token type, which is reserved for interchain tokens
        if (tokenManagerType == TokenManagerType.NATIVE_INTERCHAIN_TOKEN) revert CannotDeploy(tokenManagerType);

        address deployer = msg.sender;

        if (deployer == interchainTokenFactory) {
            deployer = TOKEN_FACTORY_DEPLOYER;
        }

        tokenId = interchainTokenId(deployer, salt);

        emit InterchainTokenIdClaimed(tokenId, deployer, salt);

        if (bytes(destinationChain).length == 0) {
            _deployTokenManager(tokenId, tokenManagerType, params);
        } else {
            if (chainNameHash == keccak256(bytes(destinationChain))) revert CannotDeployRemotelyToSelf();

            _deployRemoteTokenManager(tokenId, destinationChain, gasValue, tokenManagerType, params);
        }
    }

    /**
     * @notice Used to deploy an interchain token alongside a TokenManager in another chain.
     * @dev At least the `gasValue` amount of native token must be passed to the function call. `gasValue` exists because this function can be
     * part of a multicall involving multiple functions that could make remote contract calls.
     * If minter is empty bytes, no additional minter is set on the token, only ITS is allowed to mint.
     * If the token is being deployed on the current chain, minter should correspond to an EVM address (as bytes).
     * Otherwise, an encoding appropriate to the destination chain should be used.
     * @param salt The salt to be used during deployment.
     * @param destinationChain The name of the destination chain to deploy to.
     * @param name The name of the token to be deployed.
     * @param symbol The symbol of the token to be deployed.
     * @param decimals The decimals of the token to be deployed.
     * @param minter The address that will be able to mint and burn the deployed token.
     * @param gasValue The amount of native tokens to be used to pay for gas for the remote deployment.
     * @return tokenId The tokenId corresponding to the deployed InterchainToken.
     */
    function deployInterchainToken(
        bytes32 salt,
        string calldata destinationChain,
        string memory name,
        string memory symbol,
        uint8 decimals,
        bytes memory minter,
        uint256 gasValue
    ) external payable whenNotPaused returns (bytes32 tokenId) {
        address deployer = msg.sender;

        if (deployer == interchainTokenFactory) deployer = TOKEN_FACTORY_DEPLOYER;

        tokenId = interchainTokenId(deployer, salt);

        emit InterchainTokenIdClaimed(tokenId, deployer, salt);

        if (bytes(destinationChain).length == 0) {
            address tokenAddress = _deployInterchainToken(tokenId, minter, name, symbol, decimals);

            _deployTokenManager(tokenId, TokenManagerType.NATIVE_INTERCHAIN_TOKEN, abi.encode(minter, tokenAddress));
        } else {
            if (chainNameHash == keccak256(bytes(destinationChain))) revert CannotDeployRemotelyToSelf();

            _deployRemoteInterchainToken(tokenId, name, symbol, decimals, minter, destinationChain, gasValue);
        }
    }

    /**
     * @notice Returns the amount of token that this call is worth.
     * @dev If `tokenAddress` is `0`, then value is in terms of the native token, otherwise it's in terms of the token address.
     * @param sourceChain The source chain.
     * @param sourceAddress The source address on the source chain.
     * @param payload The payload sent with the call.
     * @return address The token address.
     * @return uint256 The value the call is worth.
     */
    function contractCallValue(
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) public view virtual onlyRemoteService(sourceChain, sourceAddress) whenNotPaused returns (address, uint256) {
        return _contractCallValue(payload);
    }

    /**
     * @notice Express executes operations based on the payload and selector.
     * @param commandId The unique message id.
     * @param sourceChain The chain where the transaction originates from.
     * @param sourceAddress The address of the remote ITS where the transaction originates from.
     * @param payload The encoded data payload for the transaction.
     */
    function expressExecute(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) public payable whenNotPaused {
        uint256 messageType = abi.decode(payload, (uint256));
        if (messageType != MESSAGE_TYPE_INTERCHAIN_TRANSFER) {
            revert InvalidExpressMessageType(messageType);
        }

        if (gateway.isCommandExecuted(commandId)) revert AlreadyExecuted();

        address expressExecutor = msg.sender;
        bytes32 payloadHash = keccak256(payload);

        emit ExpressExecuted(commandId, sourceChain, sourceAddress, payloadHash, expressExecutor);

        _setExpressExecutor(commandId, sourceChain, sourceAddress, payloadHash, expressExecutor);

        _expressExecute(commandId, sourceChain, payload);
    }

    /**
     * @notice Returns the express executor for a given command.
     * @param commandId The commandId for the contractCall.
     * @param sourceChain The source chain.
     * @param sourceAddress The source address.
     * @param payloadHash The hash of the payload.
     * @return expressExecutor The address of the express executor.
     */
    function getExpressExecutor(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes32 payloadHash
    ) external view returns (address expressExecutor) {
        expressExecutor = _getExpressExecutor(commandId, sourceChain, sourceAddress, payloadHash);
    }

    /**
     * @notice Uses the caller's tokens to fullfill a sendCall ahead of time. Use this only if you have detected an outgoing
     * interchainTransfer that matches the parameters passed here.
     * @param commandId The unique message id of the transfer being expressed.
     * @param sourceChain the name of the chain where the interchainTransfer originated from.
     * @param payload the payload of the receive token
     */
    function _expressExecute(bytes32 commandId, string calldata sourceChain, bytes calldata payload) internal {
        (, bytes32 tokenId, bytes memory sourceAddress, bytes memory destinationAddressBytes, uint256 amount, bytes memory data) = abi
            .decode(payload, (uint256, bytes32, bytes, bytes, uint256, bytes));
        address destinationAddress = destinationAddressBytes.toAddress();

        IERC20 token;
        {
            (bool success, bytes memory returnData) = tokenHandler.delegatecall(
                abi.encodeWithSelector(ITokenHandler.transferTokenFrom.selector, tokenId, msg.sender, destinationAddress, amount)
            );
            if (!success) revert TokenHandlerFailed(returnData);
            (amount, token) = abi.decode(returnData, (uint256, IERC20));
        }

        // slither-disable-next-line reentrancy-events
        emit InterchainTransferReceived(
            commandId,
            tokenId,
            sourceChain,
            sourceAddress,
            destinationAddress,
            amount,
            data.length == 0 ? bytes32(0) : keccak256(data)
        );

        if (data.length != 0) {
            bytes32 result = IInterchainTokenExpressExecutable(destinationAddress).expressExecuteWithInterchainToken(
                commandId,
                sourceChain,
                sourceAddress,
                data,
                tokenId,
                address(token),
                amount
            );

            if (result != EXPRESS_EXECUTE_SUCCESS) revert ExpressExecuteWithInterchainTokenFailed(destinationAddress);
        }
    }

    /**
     * @notice Initiates an interchain transfer of a specified token to a destination chain.
     * @dev The function retrieves the TokenManager associated with the tokenId.
     * @param tokenId The unique identifier of the token to be transferred.
     * @param destinationChain The destination chain to send the tokens to.
     * @param destinationAddress The address on the destination chain to send the tokens to.
     * @param amount The amount of tokens to be transferred.
     * @param metadata Optional metadata for the call for additional effects (such as calling a destination contract).
     */
    function interchainTransfer(
        bytes32 tokenId,
        string calldata destinationChain,
        bytes calldata destinationAddress,
        uint256 amount,
        bytes calldata metadata,
        uint256 gasValue
    ) external payable whenNotPaused {
        amount = _takeToken(tokenId, msg.sender, amount, false);

        (IGatewayCaller.MetadataVersion metadataVersion, bytes memory data) = _decodeMetadata(metadata);

        _transmitInterchainTransfer(tokenId, msg.sender, destinationChain, destinationAddress, amount, metadataVersion, data, gasValue);
    }

    /**
     * @notice Initiates an interchain call contract with interchain token to a destination chain.
     * @param tokenId The unique identifier of the token to be transferred.
     * @param destinationChain The destination chain to send the tokens to.
     * @param destinationAddress The address on the destination chain to send the tokens to.
     * @param amount The amount of tokens to be transferred.
     * @param data Additional data to be passed along with the transfer.
     */
    function callContractWithInterchainToken(
        bytes32 tokenId,
        string calldata destinationChain,
        bytes calldata destinationAddress,
        uint256 amount,
        bytes memory data,
        uint256 gasValue
    ) external payable whenNotPaused {
        if (data.length == 0) revert EmptyData();
        amount = _takeToken(tokenId, msg.sender, amount, false);

        _transmitInterchainTransfer(
            tokenId,
            msg.sender,
            destinationChain,
            destinationAddress,
            amount,
            IGatewayCaller.MetadataVersion.CONTRACT_CALL,
            data,
            gasValue
        );
    }

    /**
     * \
     * TOKEN ONLY FUNCTIONS
     * \*****************
     */

    /**
     * @notice Transmit an interchain transfer for the given tokenId.
     * @dev Only callable by a token registered under a tokenId.
     * @param tokenId The tokenId of the token (which must be the msg.sender).
     * @param sourceAddress The address where the token is coming from.
     * @param destinationChain The name of the chain to send tokens to.
     * @param destinationAddress The destinationAddress for the interchainTransfer.
     * @param amount The amount of token to give.
     * @param metadata Optional metadata for the call for additional effects (such as calling a destination contract).
     */
    function transmitInterchainTransfer(
        bytes32 tokenId,
        address sourceAddress,
        string calldata destinationChain,
        bytes memory destinationAddress,
        uint256 amount,
        bytes calldata metadata
    ) external payable whenNotPaused {
        amount = _takeToken(tokenId, sourceAddress, amount, true);

        (IGatewayCaller.MetadataVersion metadataVersion, bytes memory data) = _decodeMetadata(metadata);

        _transmitInterchainTransfer(tokenId, sourceAddress, destinationChain, destinationAddress, amount, metadataVersion, data, msg.value);
    }

    /**
     * \
     * OWNER FUNCTIONS
     * \************
     */

    /**
     * @notice Used to set a flow limit for a token manager that has the service as its operator.
     * @param tokenIds An array of the tokenIds of the tokenManagers to set the flow limits of.
     * @param flowLimits The flowLimits to set.
     */
    function setFlowLimits(bytes32[] calldata tokenIds, uint256[] calldata flowLimits) external onlyRole(uint8(Roles.OPERATOR)) {
        uint256 length = tokenIds.length;
        if (length != flowLimits.length) revert LengthMismatch();

        for (uint256 i; i < length; ++i) {
            ITokenManager tokenManager_ = ITokenManager(validTokenManagerAddress(tokenIds[i]));
            // slither-disable-next-line calls-loop
            tokenManager_.setFlowLimit(flowLimits[i]);
        }
    }

    /**
     * @notice Used to set a trusted address for a chain.
     * @param chain The chain to set the trusted address of.
     * @param address_ The address to set as trusted.
     */
    function setTrustedAddress(string memory chain, string memory address_) external onlyOwner {
        _setTrustedAddress(chain, address_);
    }

    /**
     * @notice Used to remove a trusted address for a chain.
     * @param chain The chain to set the trusted address of.
     */
    function removeTrustedAddress(string memory chain) external onlyOwner {
        _removeTrustedAddress(chain);
    }

    /**
     * @notice Allows the owner to pause/unpause the token service.
     * @param paused Boolean value representing whether to pause or unpause.
     */
    function setPauseStatus(bool paused) external onlyOwner {
        if (paused) {
            _pause();
        } else {
            _unpause();
        }
    }

    /**
     * \
     * INTERNAL FUNCTIONS
     * \***************
     */
    function _setup(bytes calldata params) internal override {
        (address operator, string memory chainName_, string[] memory trustedChainNames, string[] memory trustedAddresses) = abi.decode(
            params,
            (address, string, string[], string[])
        );
        uint256 length = trustedChainNames.length;

        if (operator == address(0)) revert ZeroAddress();
        if (bytes(chainName_).length == 0 || keccak256(bytes(chainName_)) != chainNameHash) revert InvalidChainName();
        if (length != trustedAddresses.length) revert LengthMismatch();

        _addOperator(operator);
        _setChainName(chainName_);

        for (uint256 i; i < length; ++i) {
            _setTrustedAddress(trustedChainNames[i], trustedAddresses[i]);
        }
    }

    /**
     * @notice Executes operations based on the payload and selector.
     * @param commandId The unique message id.
     * @param sourceChain The chain where the transaction originates from.
     * @param sourceAddress The address of the remote ITS where the transaction originates from.
     * @param payload The encoded data payload for the transaction.
     */
    function execute(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes calldata payload
    ) external onlyRemoteService(sourceChain, sourceAddress) whenNotPaused {
        bytes32 payloadHash = keccak256(payload);

        if (!gateway.validateContractCall(commandId, sourceChain, sourceAddress, payloadHash)) {
            revert NotApprovedByGateway();
        }

        _execute(commandId, sourceChain, sourceAddress, payload, payloadHash);
    }

    /**
     * @notice Processes the payload data for a send token call.
     * @param commandId The unique message id.
     * @param expressExecutor The address of the express executor. Equals `address(0)` if it wasn't expressed.
     * @param sourceChain The chain where the transaction originates from.
     * @param payload The encoded data payload to be processed.
     */
    function _processInterchainTransferPayload(
        bytes32 commandId,
        address expressExecutor,
        string memory sourceChain,
        bytes memory payload
    ) internal {
        bytes32 tokenId;
        bytes memory sourceAddress;
        address destinationAddress;
        uint256 amount;
        bytes memory data;
        {
            bytes memory destinationAddressBytes;
            (, tokenId, sourceAddress, destinationAddressBytes, amount, data) = abi.decode(
                payload,
                (uint256, bytes32, bytes, bytes, uint256, bytes)
            );
            destinationAddress = destinationAddressBytes.toAddress();
        }

        // Return token to the express executor
        if (expressExecutor != address(0)) {
            _giveToken(tokenId, expressExecutor, amount);
            return;
        }

        address tokenAddress;
        (amount, tokenAddress) = _giveToken(tokenId, destinationAddress, amount);

        // slither-disable-next-line reentrancy-events
        emit InterchainTransferReceived(
            commandId,
            tokenId,
            sourceChain,
            sourceAddress,
            destinationAddress,
            amount,
            data.length == 0 ? bytes32(0) : keccak256(data)
        );

        if (data.length != 0) {
            bytes32 result = IInterchainTokenExecutable(destinationAddress).executeWithInterchainToken(
                commandId,
                sourceChain,
                sourceAddress,
                data,
                tokenId,
                tokenAddress,
                amount
            );

            if (result != EXECUTE_SUCCESS) revert ExecuteWithInterchainTokenFailed(destinationAddress);
        }
    }

    /**
     * @notice Processes a deploy token manager payload.
     */
    function _processDeployTokenManagerPayload(bytes memory payload) internal {
        (, bytes32 tokenId, TokenManagerType tokenManagerType, bytes memory params) = abi.decode(
            payload,
            (uint256, bytes32, TokenManagerType, bytes)
        );

        if (tokenManagerType == TokenManagerType.NATIVE_INTERCHAIN_TOKEN) revert CannotDeploy(tokenManagerType);

        _deployTokenManager(tokenId, tokenManagerType, params);
    }

    /**
     * @notice Processes a deploy interchain token manager payload.
     * @param payload The encoded data payload to be processed.
     */
    function _processDeployInterchainTokenPayload(bytes memory payload) internal {
        (, bytes32 tokenId, string memory name, string memory symbol, uint8 decimals, bytes memory minterBytes) = abi.decode(
            payload,
            (uint256, bytes32, string, string, uint8, bytes)
        );
        address tokenAddress;

        tokenAddress = _deployInterchainToken(tokenId, minterBytes, name, symbol, decimals);

        _deployTokenManager(tokenId, TokenManagerType.NATIVE_INTERCHAIN_TOKEN, abi.encode(minterBytes, tokenAddress));
    }

    /**
     * @notice Calls a contract on a specific destination chain with the given payload
     * @dev This method also determines whether the ITS call should be routed via the ITS Hub.
     * If the `trustedAddress(destinationChain) == 'hub'`, then the call is wrapped and routed to the ITS Hub destination.
     * @param destinationChain The target chain where the contract will be called.
     * @param payload The data payload for the transaction.
     * @param gasValue The amount of gas to be paid for the transaction.
     */
    function _callContract(
        string memory destinationChain,
        bytes memory payload,
        IGatewayCaller.MetadataVersion metadataVersion,
        uint256 gasValue
    ) internal {
        string memory destinationAddress;

        (destinationChain, destinationAddress, payload) = _getCallParams(destinationChain, payload);

        (bool success, bytes memory returnData) = gatewayCaller.delegatecall(
            abi.encodeWithSelector(
                IGatewayCaller.callContract.selector,
                destinationChain,
                destinationAddress,
                payload,
                metadataVersion,
                gasValue
            )
        );

        if (!success) revert GatewayCallFailed(returnData);
    }

    /**
     * @dev Get the params for the cross-chain message, taking routing via ITS Hub into account.
     */
    function _getCallParams(
        string memory destinationChain,
        bytes memory payload
    ) internal view returns (string memory, string memory, bytes memory) {
        string memory destinationAddress = trustedAddress(destinationChain);

        // Prevent sending directly to the ITS Hub chain. This is not supported yet, so fail early to prevent the user from having their funds stuck.
        if (keccak256(abi.encodePacked(destinationChain)) == ITS_HUB_CHAIN_NAME_HASH) revert UntrustedChain();

        // Check whether the ITS call should be routed via ITS hub for this destination chain
        if (keccak256(abi.encodePacked(destinationAddress)) == ITS_HUB_ROUTING_IDENTIFIER_HASH) {
            // Wrap ITS message in an ITS Hub message
            payload = abi.encode(MESSAGE_TYPE_SEND_TO_HUB, destinationChain, payload);
            destinationChain = ITS_HUB_CHAIN_NAME;
            destinationAddress = trustedAddress(ITS_HUB_CHAIN_NAME);
        }

        // Check whether no trusted address was set for the destination chain
        if (bytes(destinationAddress).length == 0) revert UntrustedChain();

        return (destinationChain, destinationAddress, payload);
    }

    function _execute(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes memory payload,
        bytes32 payloadHash
    ) internal {
        uint256 messageType;
        string memory originalSourceChain;
        (messageType, originalSourceChain, payload) = _getExecuteParams(sourceChain, payload);

        if (messageType == MESSAGE_TYPE_INTERCHAIN_TRANSFER) {
            address expressExecutor = _getExpressExecutorAndEmitEvent(commandId, sourceChain, sourceAddress, payloadHash);
            _processInterchainTransferPayload(commandId, expressExecutor, originalSourceChain, payload);
        } else if (messageType == MESSAGE_TYPE_DEPLOY_TOKEN_MANAGER) {
            _processDeployTokenManagerPayload(payload);
        } else if (messageType == MESSAGE_TYPE_DEPLOY_INTERCHAIN_TOKEN) {
            _processDeployInterchainTokenPayload(payload);
        } else {
            revert InvalidMessageType(messageType);
        }
    }

    function _getMessageType(bytes memory payload) internal pure returns (uint256 messageType) {
        if (payload.length < 32) revert InvalidPayload();

        /// @solidity memory-safe-assembly
        assembly {
            messageType := mload(add(payload, 32))
        }
    }

    /**
     * @dev Return the parameters for the execute call, taking routing via ITS Hub into account.
     */
    function _getExecuteParams(
        string calldata sourceChain,
        bytes memory payload
    ) internal view returns (uint256, string memory, bytes memory) {
        // Read the first 32 bytes of the payload to determine the message type
        uint256 messageType = _getMessageType(payload);

        // True source chain, this is overridden if the ITS call is coming via the ITS hub
        string memory originalSourceChain = sourceChain;

        // Unwrap ITS message if coming from ITS hub
        if (messageType == MESSAGE_TYPE_RECEIVE_FROM_HUB) {
            if (keccak256(abi.encodePacked(sourceChain)) != ITS_HUB_CHAIN_NAME_HASH) revert UntrustedChain();

            (, originalSourceChain, payload) = abi.decode(payload, (uint256, string, bytes));

            // Check whether the original source chain is expected to be routed via the ITS Hub
            if (trustedAddressHash(originalSourceChain) != ITS_HUB_ROUTING_IDENTIFIER_HASH) revert UntrustedChain();

            // Get message type of the inner ITS message
            messageType = _getMessageType(payload);
        } else {
            // Prevent receiving a direct message from the ITS Hub. This is not supported yet.
            if (keccak256(abi.encodePacked(sourceChain)) == ITS_HUB_CHAIN_NAME_HASH) revert UntrustedChain();
        }

        return (messageType, originalSourceChain, payload);
    }

    /**
     * @notice Deploys a token manager on a destination chain.
     * @param tokenId The ID of the token.
     * @param destinationChain The chain where the token manager will be deployed.
     * @param gasValue The amount of gas to be paid for the transaction.
     * @param tokenManagerType The type of token manager to be deployed.
     * @param params Additional parameters for the token manager deployment.
     */
    function _deployRemoteTokenManager(
        bytes32 tokenId,
        string calldata destinationChain,
        uint256 gasValue,
        TokenManagerType tokenManagerType,
        bytes calldata params
    ) internal {
        // slither-disable-next-line unused-return
        validTokenManagerAddress(tokenId);

        emit TokenManagerDeploymentStarted(tokenId, destinationChain, tokenManagerType, params);

        bytes memory payload = abi.encode(MESSAGE_TYPE_DEPLOY_TOKEN_MANAGER, tokenId, tokenManagerType, params);

        _callContract(destinationChain, payload, IGatewayCaller.MetadataVersion.CONTRACT_CALL, gasValue);
    }

    /**
     * @notice Deploys an interchain token on a destination chain.
     * @param tokenId The ID of the token.
     * @param name The name of the token.
     * @param symbol The symbol of the token.
     * @param decimals The number of decimals of the token.
     * @param minter The minter address for the token.
     * @param destinationChain The destination chain where the token will be deployed.
     * @param gasValue The amount of gas to be paid for the transaction.
     */
    function _deployRemoteInterchainToken(
        bytes32 tokenId,
        string memory name,
        string memory symbol,
        uint8 decimals,
        bytes memory minter,
        string calldata destinationChain,
        uint256 gasValue
    ) internal {
        // slither-disable-next-line unused-return
        validTokenManagerAddress(tokenId);

        // slither-disable-next-line reentrancy-events
        emit InterchainTokenDeploymentStarted(tokenId, name, symbol, decimals, minter, destinationChain);

        bytes memory payload = abi.encode(MESSAGE_TYPE_DEPLOY_INTERCHAIN_TOKEN, tokenId, name, symbol, decimals, minter);

        _callContract(destinationChain, payload, IGatewayCaller.MetadataVersion.CONTRACT_CALL, gasValue);
    }

    /**
     * @notice Deploys a token manager.
     * @param tokenId The ID of the token.
     * @param tokenManagerType The type of the token manager to be deployed.
     * @param params Additional parameters for the token manager deployment.
     */
    function _deployTokenManager(bytes32 tokenId, TokenManagerType tokenManagerType, bytes memory params) internal {
        (bool success, bytes memory returnData) = tokenManagerDeployer.delegatecall(
            abi.encodeWithSelector(ITokenManagerDeployer.deployTokenManager.selector, tokenId, tokenManagerType, params)
        );
        if (!success) revert TokenManagerDeploymentFailed(returnData);

        address tokenManager_;
        assembly {
            tokenManager_ := mload(add(returnData, 0x20))
        }

        (success, returnData) = tokenHandler.delegatecall(
            abi.encodeWithSelector(ITokenHandler.postTokenManagerDeploy.selector, tokenManagerType, tokenManager_)
        );
        if (!success) revert PostDeployFailed(returnData);

        // slither-disable-next-line reentrancy-events
        emit TokenManagerDeployed(tokenId, tokenManager_, tokenManagerType, params);
    }

    /**
     * @notice Computes the salt for an interchain token deployment.
     * @param tokenId The ID of the token.
     * @return salt The computed salt for the token deployment.
     */
    function _getInterchainTokenSalt(bytes32 tokenId) internal pure returns (bytes32 salt) {
        salt = keccak256(abi.encode(PREFIX_INTERCHAIN_TOKEN_SALT, tokenId));
    }

    /**
     * @notice Deploys an interchain token.
     * @param tokenId The ID of the token.
     * @param minterBytes The minter address for the token.
     * @param name The name of the token.
     * @param symbol The symbol of the token.
     * @param decimals The number of decimals of the token.
     */
    function _deployInterchainToken(
        bytes32 tokenId,
        bytes memory minterBytes,
        string memory name,
        string memory symbol,
        uint8 decimals
    ) internal returns (address tokenAddress) {
        bytes32 salt = _getInterchainTokenSalt(tokenId);

        address minter;
        if (bytes(minterBytes).length != 0) minter = minterBytes.toAddress();

        (bool success, bytes memory returnData) = interchainTokenDeployer.delegatecall(
            abi.encodeWithSelector(IInterchainTokenDeployer.deployInterchainToken.selector, salt, tokenId, minter, name, symbol, decimals)
        );
        if (!success) {
            revert InterchainTokenDeploymentFailed(returnData);
        }

        assembly {
            tokenAddress := mload(add(returnData, 0x20))
        }

        /**
         * @dev Add the provided address as a minter to allow it to mint and burn tokens.
         * If `address(0)` was provided, add it as a minter to allow
         * anyone to easily check that no custom minter was set.
         */
        _addTokenMinter(tokenAddress, minter);

        // slither-disable-next-line reentrancy-events
        emit InterchainTokenDeployed(tokenId, tokenAddress, minter, name, symbol, decimals);
    }

    /**
     * @notice Decodes the metadata into a version number and data bytes.
     * @dev The function expects the metadata to have the version in the first 4 bytes, followed by the actual data.
     * @param metadata The bytes containing the metadata to decode.
     * @return version The version number extracted from the metadata.
     * @return data The data bytes extracted from the metadata.
     */
    function _decodeMetadata(bytes calldata metadata) internal pure returns (IGatewayCaller.MetadataVersion version, bytes memory data) {
        if (metadata.length < 4) return (IGatewayCaller.MetadataVersion.CONTRACT_CALL, data);

        uint32 versionUint = uint32(bytes4(metadata[:4]));
        if (versionUint > LATEST_METADATA_VERSION) revert InvalidMetadataVersion(versionUint);

        version = IGatewayCaller.MetadataVersion(versionUint);

        if (metadata.length == 4) return (version, data);

        data = metadata[4:];
    }

    /**
     * @notice Transmit a callContractWithInterchainToken for the given tokenId.
     * @param tokenId The tokenId of the TokenManager (which must be the msg.sender).
     * @param sourceAddress The address where the token is coming from, which will also be used for gas reimbursement.
     * @param destinationChain The name of the chain to send tokens to.
     * @param destinationAddress The destinationAddress for the interchainTransfer.
     * @param amount The amount of tokens to send.
     * @param metadataVersion The version of the metadata.
     * @param data The data to be passed with the token transfer.
     * @param gasValue The amount of gas to be paid for the transaction.
     */
    function _transmitInterchainTransfer(
        bytes32 tokenId,
        address sourceAddress,
        string calldata destinationChain,
        bytes memory destinationAddress,
        uint256 amount,
        IGatewayCaller.MetadataVersion metadataVersion,
        bytes memory data,
        uint256 gasValue
    ) internal {
        if (amount == 0) revert ZeroAmount();

        // slither-disable-next-line reentrancy-events
        emit InterchainTransfer(
            tokenId,
            sourceAddress,
            destinationChain,
            destinationAddress,
            amount,
            data.length == 0 ? bytes32(0) : keccak256(data)
        );

        bytes memory payload = abi.encode(
            MESSAGE_TYPE_INTERCHAIN_TRANSFER,
            tokenId,
            sourceAddress.toBytes(),
            destinationAddress,
            amount,
            data
        );

        _callContract(destinationChain, payload, metadataVersion, gasValue);
    }

    /**
     * @dev Takes token from a sender via the token service. `tokenOnly` indicates if the caller should be restricted to the token only.
     */
    function _takeToken(bytes32 tokenId, address from, uint256 amount, bool tokenOnly) internal returns (uint256) {
        (bool success, bytes memory data) = tokenHandler.delegatecall(
            abi.encodeWithSelector(ITokenHandler.takeToken.selector, tokenId, tokenOnly, from, amount)
        );
        if (!success) revert TakeTokenFailed(data);
        amount = abi.decode(data, (uint256));

        return amount;
    }

    /**
     * @dev Gives token to recipient via the token service.
     */
    function _giveToken(bytes32 tokenId, address to, uint256 amount) internal returns (uint256, address tokenAddress) {
        (bool success, bytes memory data) = tokenHandler.delegatecall(
            abi.encodeWithSelector(ITokenHandler.giveToken.selector, tokenId, to, amount)
        );
        if (!success) revert GiveTokenFailed(data);
        (amount, tokenAddress) = abi.decode(data, (uint256, address));

        return (amount, tokenAddress);
    }

    /**
     * @notice Returns the amount of token that this call is worth.
     * @dev If `tokenAddress` is `0`, then value is in terms of the native token, otherwise it's in terms of the token address.
     * @param payload The payload sent with the call.
     * @return address The token address.
     * @return uint256 The value the call is worth.
     */
    function _contractCallValue(bytes calldata payload) internal view returns (address, uint256) {
        (uint256 messageType, bytes32 tokenId, , , uint256 amount) = abi.decode(payload, (uint256, bytes32, bytes, bytes, uint256));
        if (messageType != MESSAGE_TYPE_INTERCHAIN_TRANSFER) {
            revert InvalidExpressMessageType(messageType);
        }

        return (validTokenAddress(tokenId), amount);
    }

    function _getExpressExecutorAndEmitEvent(
        bytes32 commandId,
        string calldata sourceChain,
        string calldata sourceAddress,
        bytes32 payloadHash
    ) internal returns (address expressExecutor) {
        expressExecutor = _popExpressExecutor(commandId, sourceChain, sourceAddress, payloadHash);

        if (expressExecutor != address(0)) {
            emit ExpressExecutionFulfilled(commandId, sourceChain, sourceAddress, payloadHash, expressExecutor);
        }
    }
}
