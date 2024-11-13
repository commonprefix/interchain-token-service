'use strict';

const chai = require('chai');
const { expect } = chai;
const { ethers } = require('hardhat');
const {
    Wallet,
    constants: { MaxUint256, AddressZero, HashZero },
    utils: { defaultAbiCoder, solidityPack, keccak256, toUtf8Bytes, hexlify, id },
    getContractAt,
} = ethers;
const Create3Deployer = require('@axelar-network/axelar-gmp-sdk-solidity/artifacts/contracts/deploy/Create3Deployer.sol/Create3Deployer.json');
const { getCreate3Address } = require('@axelar-network/axelar-gmp-sdk-solidity');
const { approveContractCall } = require('../scripts/utils');
const { getRandomBytes32, getRandomInt, expectRevert, gasReporter, getEVMVersion } = require('./utils');
const { deployAll, deployContract, deployInterchainTokenService } = require('../scripts/deploy');
const {
    MESSAGE_TYPE_INTERCHAIN_TRANSFER,
    MESSAGE_TYPE_DEPLOY_INTERCHAIN_TOKEN,
    MESSAGE_TYPE_DEPLOY_TOKEN_MANAGER,
    MESSAGE_TYPE_RECEIVE_FROM_HUB,
    INVALID_MESSAGE_TYPE,
    NATIVE_INTERCHAIN_TOKEN,
    MINT_BURN_FROM,
    LOCK_UNLOCK,
    LOCK_UNLOCK_FEE_ON_TRANSFER,
    MINT_BURN,
    OPERATOR_ROLE,
    FLOW_LIMITER_ROLE,
    ITS_HUB_CHAIN_NAME,
    ITS_HUB_ROUTING_IDENTIFIER,
    ITS_HUB_ADDRESS,
} = require('./constants');

const reportGas = gasReporter('Interchain Token Service');

describe('Interchain Token Service', () => {
    let wallet, otherWallet;
    let service, gateway, gasService, testToken;

    let create3Deployer;
    let tokenManagerDeployer;
    let interchainToken;
    let interchainTokenDeployer;
    let tokenManager;
    let tokenHandler;
    let gatewayCaller;

    const chainName = 'Test';
    const deploymentKey = 'InterchainTokenService';
    const factoryDeploymentKey = 'factoryKey';

    const deployFunctions = {};
    const destinationChain = 'destination chain';
    const sourceChain = 'source chain';
    const gasValue = 12;

    async function deployNewLockUnlock(service, tokenName, tokenSymbol, tokenDecimals, mintAmount = 0, skipApprove = false) {
        const salt = getRandomBytes32();
        const tokenId = await service.interchainTokenId(wallet.address, salt);
        const tokenManager = await getContractAt('TokenManager', await service.tokenManagerAddress(tokenId), wallet);

        const token = await deployContract(wallet, 'TestInterchainTokenStandard', [
            tokenName,
            tokenSymbol,
            tokenDecimals,
            service.address,
            tokenId,
        ]);
        const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);

        await service.deployTokenManager(salt, '', LOCK_UNLOCK, params, 0).then((tx) => tx.wait);

        if (mintAmount > 0) {
            await token.mint(wallet.address, mintAmount).then((tx) => tx.wait);
            if (!skipApprove) await token.approve(service.address, mintAmount).then((tx) => tx.wait);
        }

        return [token, tokenManager, tokenId];
    }

    async function deployNewLockUnlockFee(
        service,
        tokenName,
        tokenSymbol,
        tokenDecimals,
        mintAmount = 0,
        skipApprove = false,
        type = 'normal',
    ) {
        const salt = getRandomBytes32();
        const tokenId = await service.interchainTokenId(wallet.address, salt);
        const tokenManager = await getContractAt('TokenManager', await service.tokenManagerAddress(tokenId), wallet);

        let token;

        if (type === 'free') {
            token = await deployContract(wallet, 'TestFeeOnTransferTokenNoFee', [
                tokenName,
                tokenSymbol,
                tokenDecimals,
                service.address,
                tokenId,
            ]);
        } else if (type === 'reentrant') {
            token = await deployContract(wallet, 'TestFeeOnTransferTokenInvalid', [
                tokenName,
                tokenSymbol,
                tokenDecimals,
                service.address,
                tokenId,
            ]);
        } else {
            token = await deployContract(wallet, 'TestFeeOnTransferToken', [
                tokenName,
                tokenSymbol,
                tokenDecimals,
                service.address,
                tokenId,
            ]);
        }

        const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);

        await service.deployTokenManager(salt, '', LOCK_UNLOCK_FEE_ON_TRANSFER, params, 0).then((tx) => tx.wait);

        if (mintAmount > 0) {
            await token.mint(wallet.address, mintAmount).then((tx) => tx.wait);

            if (!skipApprove) {
                await token.approve(service.address, mintAmount).then((tx) => tx.wait);
            }
        }

        return [token, tokenManager, tokenId];
    }

    const makeDeployNewMintBurn = (type) =>
        async function deployNewMintBurn(service, tokenName, tokenSymbol, tokenDecimals, mintAmount = 0) {
            const salt = getRandomBytes32();
            const tokenId = await service.interchainTokenId(wallet.address, salt);
            const token = await deployContract(wallet, 'TestInterchainTokenStandard', [
                tokenName,
                tokenSymbol,
                tokenDecimals,
                service.address,
                tokenId,
            ]);

            const tokenManager = await getContractAt('TokenManager', await service.tokenManagerAddress(tokenId), wallet);

            if (mintAmount > 0) {
                await token.mint(wallet.address, mintAmount).then((tx) => tx.wait);
            }

            await token.transferMintership(tokenManager.address).then((tx) => tx.wait);

            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);
            await service.deployTokenManager(salt, '', type, params, 0).then((tx) => tx.wait);

            return [token, tokenManager, tokenId];
        };

    deployFunctions.lockUnlock = deployNewLockUnlock;
    deployFunctions.lockUnlockFee = deployNewLockUnlockFee;
    deployFunctions.mintBurn = makeDeployNewMintBurn(MINT_BURN);
    deployFunctions.mintBurnFrom = makeDeployNewMintBurn(MINT_BURN_FROM);

    before(async () => {
        const wallets = await ethers.getSigners();
        wallet = wallets[0];
        otherWallet = wallets[1];
        ({
            service,
            gateway,
            gasService,
            create3Deployer,
            tokenManagerDeployer,
            interchainToken,
            interchainTokenDeployer,
            tokenManager,
            tokenHandler,
            gatewayCaller,
        } = await deployAll(wallet, 'Test', [sourceChain, destinationChain]));

        testToken = await deployContract(wallet, 'TestInterchainTokenStandard', [
            'Test Token',
            'TST',
            18,
            service.address,
            getRandomBytes32(),
        ]);
    });

    describe('Interchain Token Service Deployment', () => {
        let interchainTokenFactoryAddress;
        let serviceTest;

        before(async () => {
            interchainTokenFactoryAddress = await getCreate3Address(create3Deployer.address, wallet, factoryDeploymentKey);
            serviceTest = await deployContract(wallet, 'TestInterchainTokenService', [
                tokenManagerDeployer.address,
                interchainTokenDeployer.address,
                gateway.address,
                gasService.address,
                interchainTokenFactoryAddress,
                chainName,
                tokenManager.address,
                tokenHandler.address,
                gatewayCaller.address,
            ]);
        });

        it('Should test setup revert cases', async () => {
            const operator = wallet.address;
            const trustedChainNames = ['ChainA', 'ChainB'];
            const trustedAddresses = [wallet.address, wallet.address];

            let params = defaultAbiCoder.encode(
                ['address', 'string', 'string[]', 'string[]'],
                [AddressZero, chainName, trustedChainNames, trustedAddresses],
            );

            await expectRevert((gasOptions) => serviceTest.setupTest(params, gasOptions), serviceTest, 'ZeroAddress');

            params = defaultAbiCoder.encode(
                ['address', 'string', 'string[]', 'string[]'],
                [operator, '', trustedChainNames, trustedAddresses],
            );

            await expectRevert((gasOptions) => serviceTest.setupTest(params, gasOptions), serviceTest, 'InvalidChainName');

            params = defaultAbiCoder.encode(
                ['address', 'string', 'string[]', 'string[]'],
                [operator, 'Invalid', trustedChainNames, trustedAddresses],
            );

            await expectRevert((gasOptions) => serviceTest.setupTest(params, gasOptions), serviceTest, 'InvalidChainName');

            trustedAddresses.pop();

            params = defaultAbiCoder.encode(
                ['address', 'string', 'string[]', 'string[]'],
                [operator, chainName, trustedChainNames, trustedAddresses],
            );

            await expectRevert((gasOptions) => serviceTest.setupTest(params, gasOptions), serviceTest, 'LengthMismatch');
        });

        it('Should revert on invalid interchain token factory', async () => {
            await expectRevert(
                (gasOptions) =>
                    deployInterchainTokenService(
                        wallet,
                        create3Deployer.address,
                        tokenManagerDeployer.address,
                        interchainTokenDeployer.address,
                        gateway.address,
                        gasService.address,
                        AddressZero,
                        tokenManager.address,
                        tokenHandler.address,
                        gatewayCaller.address,
                        chainName,
                        [],
                        deploymentKey,
                        gasOptions,
                    ),
                service,
                'ZeroAddress',
            );
        });

        it('Should revert on invalid gas service', async () => {
            await expectRevert(
                (gasOptions) =>
                    deployInterchainTokenService(
                        wallet,
                        create3Deployer.address,
                        tokenManagerDeployer.address,
                        interchainTokenDeployer.address,
                        gateway.address,
                        AddressZero,
                        interchainTokenFactoryAddress,
                        tokenManager.address,
                        tokenHandler.address,
                        gatewayCaller.address,
                        chainName,
                        [],
                        deploymentKey,
                        gasOptions,
                    ),
                service,
                'ZeroAddress',
            );
        });

        it('Should revert on invalid chain name', async () => {
            await expectRevert(
                (gasOptions) =>
                    deployInterchainTokenService(
                        wallet,
                        create3Deployer.address,
                        tokenManagerDeployer.address,
                        interchainTokenDeployer.address,
                        gateway.address,
                        gasService.address,
                        interchainTokenFactoryAddress,
                        tokenManager.address,
                        tokenHandler.address,
                        gatewayCaller.address,
                        '',
                        [],
                        deploymentKey,
                        gasOptions,
                    ),
                service,
                'InvalidChainName',
            );
        });

        it('Should revert on invalid token manager deployer', async () => {
            await expectRevert((gasOptions) =>
                deployInterchainTokenService(
                    wallet,
                    create3Deployer.address,
                    AddressZero,
                    interchainTokenDeployer.address,
                    gateway.address,
                    gasService.address,
                    interchainTokenFactoryAddress,
                    tokenManager.address,
                    tokenHandler.address,
                    gatewayCaller.address,
                    chainName,
                    [],
                    deploymentKey,
                    gasOptions,
                ),
            );
        });

        it('Should revert on invalid interchain token deployer', async () => {
            await expectRevert(
                (gasOptions) =>
                    deployInterchainTokenService(
                        wallet,
                        create3Deployer.address,
                        tokenManagerDeployer.address,
                        AddressZero,
                        gateway.address,
                        gasService.address,
                        interchainTokenFactoryAddress,
                        tokenManager.address,
                        tokenHandler.address,
                        gatewayCaller.address,
                        chainName,
                        [],
                        deploymentKey,
                        gasOptions,
                    ),
                service,
                'ZeroAddress',
            );
        });

        it('Should revert on invalid gateway', async () => {
            await expectRevert(
                (gasOptions) =>
                    deployInterchainTokenService(
                        wallet,
                        create3Deployer.address,
                        tokenManagerDeployer.address,
                        interchainTokenDeployer.address,
                        AddressZero,
                        gasService.address,
                        interchainTokenFactoryAddress,
                        tokenManager.address,
                        tokenHandler.address,
                        gatewayCaller.address,
                        chainName,
                        [],
                        deploymentKey,
                        gasOptions,
                    ),
                service,
                'ZeroAddress',
            );
        });

        it('Should revert on invalid token manager implementation', async () => {
            await expectRevert(
                (gasOptions) =>
                    deployInterchainTokenService(
                        wallet,
                        create3Deployer.address,
                        tokenManagerDeployer.address,
                        interchainTokenDeployer.address,
                        gateway.address,
                        gasService.address,
                        interchainTokenFactoryAddress,
                        AddressZero,
                        tokenHandler.address,
                        gatewayCaller.address,
                        chainName,
                        [],
                        deploymentKey,
                        gasOptions,
                    ),
                service,
                'ZeroAddress',
            );
        });

        it('Should revert on invalid token handler', async () => {
            await expectRevert(
                (gasOptions) =>
                    deployInterchainTokenService(
                        wallet,
                        create3Deployer.address,
                        tokenManagerDeployer.address,
                        interchainTokenDeployer.address,
                        gateway.address,
                        gasService.address,
                        interchainTokenFactoryAddress,
                        tokenManager.address,
                        AddressZero,
                        gatewayCaller.address,
                        chainName,
                        [],
                        deploymentKey,
                        gasOptions,
                    ),
                service,
                'ZeroAddress',
            );
        });

        it('Should revert on invalid gateway caller', async () => {
            await expectRevert(
                (gasOptions) =>
                    deployInterchainTokenService(
                        wallet,
                        create3Deployer.address,
                        tokenManagerDeployer.address,
                        interchainTokenDeployer.address,
                        gateway.address,
                        gasService.address,
                        interchainTokenFactoryAddress,
                        tokenManager.address,
                        tokenHandler.address,
                        AddressZero,
                        chainName,
                        [],
                        deploymentKey,
                        gasOptions,
                    ),
                service,
                'ZeroAddress',
            );
        });

        it('Should return the correct contract id', async () => {
            const expectedContractid = keccak256(toUtf8Bytes('interchain-token-service'));
            const contractId = await service.contractId();
            expect(contractId).to.eq(expectedContractid);
        });

        it('Should return the token manager implementation', async () => {
            const tokenManagerImplementation = await service.tokenManagerImplementation(getRandomInt(1000));
            expect(tokenManagerImplementation).to.eq(tokenManager.address);
        });

        it('Should revert on TokenManagerProxy deployment with invalid constructor parameters', async () => {
            const salt = getRandomBytes32();
            const tokenId = await service.interchainTokenId(wallet.address, salt);
            const validParams = defaultAbiCoder.encode(['bytes', 'address'], ['0x', interchainToken.address]);
            const tokenManagerProxy = await deployContract(wallet, 'TestTokenManagerProxy', [
                service.address,
                MINT_BURN,
                tokenId,
                validParams,
            ]);
            const invalidParams = '0x1234';

            const contractId = await tokenManagerProxy.getContractId();
            const expectedContractid = keccak256(toUtf8Bytes('token-manager'));
            expect(contractId).to.eq(expectedContractid);

            await expectRevert(
                (gasOptions) => deployContract(wallet, 'TokenManagerProxy', [AddressZero, LOCK_UNLOCK, tokenId, validParams, gasOptions]),
                tokenManagerProxy,
                'ZeroAddress',
                [],
            );

            const invalidService = await deployContract(wallet, 'InvalidService');

            await expectRevert(
                (gasOptions) =>
                    deployContract(wallet, 'TokenManagerProxy', [invalidService.address, LOCK_UNLOCK, tokenId, validParams, gasOptions]),
                tokenManagerProxy,
                'InvalidImplementation',
                [],
            );

            await expectRevert(
                (gasOptions) =>
                    deployContract(wallet, 'TokenManagerProxy', [service.address, LOCK_UNLOCK, tokenId, invalidParams, gasOptions]),
                tokenManagerProxy,
                'SetupFailed',
                [],
            );

            await deployContract(wallet, 'TokenManagerProxy', [service.address, LOCK_UNLOCK, tokenId, validParams]);
        });

        it('Should revert when deploying a remote interchain token to self', async () => {
            const tokenName = 'Token Name';
            const tokenSymbol = 'TN';
            const tokenDecimals = 13;
            const salt = getRandomBytes32();

            await expectRevert(
                (gasOptions) =>
                    serviceTest.deployInterchainToken(
                        salt,
                        chainName,
                        tokenName,
                        tokenSymbol,
                        tokenDecimals,
                        wallet.address,
                        0,
                        gasOptions,
                    ),
                serviceTest,
                'CannotDeployRemotelyToSelf',
            );
        });

        it('Should revert when deploying a remote token manager to self', async () => {
            const salt = getRandomBytes32();

            await expectRevert(
                (gasOptions) =>
                    serviceTest.deployTokenManager(
                        salt,
                        chainName,
                        LOCK_UNLOCK,
                        defaultAbiCoder.encode(['bytes', 'address'], ['0x', testToken.address]),
                        0,
                        gasOptions,
                    ),
                serviceTest,
                'CannotDeployRemotelyToSelf',
            );
        });
    });

    describe('Owner functions', () => {
        const chain = 'Test';

        it('Should revert on set pause status when not called by the owner', async () => {
            await expectRevert((gasOptions) => service.connect(otherWallet).setPauseStatus(true, gasOptions), service, 'NotOwner');
        });

        it('Should revert on set trusted address when not called by the owner', async () => {
            const trustedAddress = otherWallet.address.toString();

            await expectRevert(
                (gasOptions) => service.connect(otherWallet).setTrustedAddress(chain, trustedAddress, gasOptions),
                service,
                'NotOwner',
            );
        });

        it('Should set trusted address', async () => {
            const trustedAddress = otherWallet.address.toString();

            await expect(service.setTrustedAddress(chain, trustedAddress))
                .to.emit(service, 'TrustedAddressSet')
                .withArgs(chain, trustedAddress);
        });

        it('Should revert on remove trusted address when not called by the owner', async () => {
            await expectRevert((gasOptions) => service.connect(otherWallet).removeTrustedAddress(chain, gasOptions), service, 'NotOwner');
        });

        it('Should remove trusted address', async () => {
            await expect(service.removeTrustedAddress(chain)).to.emit(service, 'TrustedAddressRemoved').withArgs(chain);
        });
    });

    describe('Token Handler', () => {
        const amount = 1234;

        it('Should revert on give token with non existing token id', async () => {
            await expectRevert((gasOptions) => tokenHandler.giveToken(getRandomBytes32(), otherWallet.address, amount, gasOptions));
        });

        it('Should revert on take token with non existing token id', async () => {
            await expectRevert((gasOptions) => tokenHandler.takeToken(getRandomBytes32(), false, otherWallet.address, amount, gasOptions));
        });

        it('Should revert on transfer token from non existing token id', async () => {
            await expectRevert((gasOptions) =>
                tokenHandler.transferTokenFrom(getRandomBytes32(), otherWallet.address, otherWallet.address, amount, gasOptions),
            );
        });
    });

    describe('Deploy and Register Interchain Token', () => {
        const tokenName = 'Token Name';
        const tokenSymbol = 'TN';
        const tokenDecimals = 13;
        const salt = getRandomBytes32();
        let tokenManager;

        it('Should register an interchain token', async () => {
            const tokenId = await service.interchainTokenId(wallet.address, salt);
            const tokenAddress = await service.interchainTokenAddress(tokenId);
            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, tokenAddress]);
            const expectedTokenManagerAddress = await service.tokenManagerAddress(tokenId);

            await expect(
                reportGas(
                    service.deployInterchainToken(salt, '', tokenName, tokenSymbol, tokenDecimals, wallet.address, 0),
                    'Call deployInterchainToken on source chain',
                ),
            )
                .to.emit(service, 'InterchainTokenIdClaimed')
                .withArgs(tokenId, wallet.address, salt)
                .to.emit(service, 'InterchainTokenDeployed')
                .withArgs(tokenId, tokenAddress, wallet.address, tokenName, tokenSymbol, tokenDecimals)
                .to.emit(service, 'TokenManagerDeployed')
                .withArgs(tokenId, expectedTokenManagerAddress, NATIVE_INTERCHAIN_TOKEN, params);

            const tokenManagerAddress = await service.deployedTokenManager(tokenId);
            expect(tokenManagerAddress).to.not.equal(AddressZero);

            tokenManager = await getContractAt('TokenManager', tokenManagerAddress, wallet);
            expect(await tokenManager.isOperator(wallet.address)).to.be.true;
            expect(await tokenManager.isOperator(service.address)).to.be.true;
            expect(await tokenManager.isFlowLimiter(wallet.address)).to.be.true;
            expect(await tokenManager.isFlowLimiter(service.address)).to.be.true;

            const token = await getContractAt('InterchainToken', tokenAddress, wallet);
            expect(await token.isMinter(wallet.address)).to.be.true;
            expect(await token.isMinter(service.address)).to.be.true;
        });

        it('Should revert when registering an interchain token as a lock/unlock for a second time', async () => {
            expect(await tokenManager.hasRole(wallet.address, OPERATOR_ROLE)).to.be.true;

            // Register the same token again
            const revertData = keccak256(toUtf8Bytes('AlreadyDeployed()')).substring(0, 10);
            await expectRevert(
                (gasOptions) =>
                    service.deployInterchainToken(salt, '', tokenName, tokenSymbol, tokenDecimals, wallet.address, 0, gasOptions),
                service,
                'InterchainTokenDeploymentFailed',
                [revertData],
            );
        });

        it('Should revert when registering an interchain token when service is paused', async () => {
            await service.setPauseStatus(true).then((tx) => tx.wait);

            await expectRevert(
                (gasOptions) =>
                    service.deployInterchainToken(salt, '', tokenName, tokenSymbol, tokenDecimals, wallet.address, 0, gasOptions),
                service,
                'Pause',
            );

            await service.setPauseStatus(false).then((tx) => tx.wait);
        });

        it('Should revert when registering an interchain token with empty token name', async () => {
            expect(await tokenManager.hasRole(wallet.address, OPERATOR_ROLE)).to.be.true;

            await expectRevert(
                (gasOptions) => service.deployInterchainToken(salt, '', '', tokenSymbol, tokenDecimals, wallet.address, 0, gasOptions),
                service,
                'EmptyTokenName',
            );
        });

        it('Should revert when registering an interchain token with empty token symbol', async () => {
            expect(await tokenManager.hasRole(wallet.address, OPERATOR_ROLE)).to.be.true;

            await expectRevert(
                (gasOptions) => service.deployInterchainToken(salt, '', tokenName, '', tokenDecimals, wallet.address, 0, gasOptions),
                service,
                'EmptyTokenSymbol',
            );
        });
    });

    describe('Deploy and Register remote Interchain Token', () => {
        const tokenName = 'Token Name';
        const tokenSymbol = 'TN';
        const tokenDecimals = 13;
        const minter = '0x12345678';
        let salt;

        before(async () => {
            salt = getRandomBytes32();
            await service
                .deployTokenManager(salt, '', LOCK_UNLOCK, defaultAbiCoder.encode(['bytes', 'address'], ['0x', testToken.address]), 0)
                .then((tx) => tx.wait);
        });

        it('Should initialize a remote interchain token deployment', async () => {
            const tokenId = await service.interchainTokenId(wallet.address, salt);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'string', 'string', 'uint8', 'bytes'],
                [MESSAGE_TYPE_DEPLOY_INTERCHAIN_TOKEN, tokenId, tokenName, tokenSymbol, tokenDecimals, minter],
            );

            await expect(
                reportGas(
                    service.deployInterchainToken(salt, destinationChain, tokenName, tokenSymbol, tokenDecimals, minter, gasValue, {
                        value: gasValue,
                    }),
                    'Send deployInterchainToken to remote chain',
                ),
            )
                .to.emit(service, 'InterchainTokenIdClaimed')
                .withArgs(tokenId, wallet.address, salt)
                .to.emit(service, 'InterchainTokenDeploymentStarted')
                .withArgs(tokenId, tokenName, tokenSymbol, tokenDecimals, minter, destinationChain)
                .and.to.emit(gasService, 'NativeGasPaidForContractCall')
                .withArgs(service.address, destinationChain, service.address, keccak256(payload), gasValue, wallet.address)
                .and.to.emit(gateway, 'ContractCall')
                .withArgs(service.address, destinationChain, service.address, keccak256(payload), payload);
        });

        it('Should revert on remote interchain token deployment if destination chain is not trusted', async () => {
            await expectRevert(
                (gasOptions) =>
                    service.deployInterchainToken(salt, 'untrusted chain', tokenName, tokenSymbol, tokenDecimals, minter, gasValue, {
                        ...gasOptions,
                        value: gasValue,
                    }),
                service,
                'UntrustedChain',
            );
        });

        it('Should revert on remote interchain token deployment with invalid token name', async () => {
            await expectRevert(
                (gasOptions) =>
                    service.deployInterchainToken(salt, destinationChain, '', tokenSymbol, tokenDecimals, minter, gasValue, {
                        ...gasOptions,
                        value: gasValue,
                    }),
                service,
                'EmptyTokenName',
            );
        });

        it('Should revert on remote interchain token deployment with invalid token symbol', async () => {
            await expectRevert(
                (gasOptions) =>
                    service.deployInterchainToken(salt, destinationChain, tokenName, '', tokenDecimals, minter, gasValue, {
                        ...gasOptions,
                        value: gasValue,
                    }),
                service,
                'EmptyTokenSymbol',
            );
        });

        it('Should revert on remote interchain token deployment if paused', async () => {
            await service.setPauseStatus(true).then((tx) => tx.wait);

            await expectRevert(
                (gasOptions) =>
                    service.deployInterchainToken(salt, destinationChain, tokenName, tokenSymbol, tokenDecimals, minter, gasValue, {
                        ...gasOptions,
                        value: gasValue,
                    }),
                service,
                'Pause',
            );

            await service.setPauseStatus(false).then((tx) => tx.wait);
        });
    });

    describe('Receive Remote Interchain Token Deployment', () => {
        const tokenName = 'Token Name';
        const tokenSymbol = 'TN';
        const tokenDecimals = 13;
        let sourceAddress;

        before(async () => {
            sourceAddress = service.address;
        });

        it('Should revert on receiving a remote interchain token deployment if not approved by the gateway', async () => {
            const tokenId = getRandomBytes32();
            const minter = wallet.address;
            const commandId = getRandomBytes32();
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'string', 'string', 'uint8', 'bytes'],
                [MESSAGE_TYPE_DEPLOY_INTERCHAIN_TOKEN, tokenId, tokenName, tokenSymbol, tokenDecimals, minter],
            );

            await expectRevert(
                (gasOptions) => service.execute(commandId, sourceChain, sourceAddress, payload, gasOptions),
                service,
                'NotApprovedByGateway',
            );
        });

        it('Should be able to receive a remote interchain token deployment with a mint/burn token manager with empty minter and operator', async () => {
            const tokenId = getRandomBytes32();
            const tokenManagerAddress = await service.tokenManagerAddress(tokenId);
            const minter = '0x';
            const operator = '0x';
            const tokenAddress = await service.interchainTokenAddress(tokenId);
            const params = defaultAbiCoder.encode(['bytes', 'address'], [operator, tokenAddress]);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'string', 'string', 'uint8', 'bytes', 'bytes'],
                [MESSAGE_TYPE_DEPLOY_INTERCHAIN_TOKEN, tokenId, tokenName, tokenSymbol, tokenDecimals, minter, operator],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expect(service.execute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(service, 'InterchainTokenDeployed')
                .withArgs(tokenId, tokenAddress, AddressZero, tokenName, tokenSymbol, tokenDecimals)
                .and.to.emit(service, 'TokenManagerDeployed')
                .withArgs(tokenId, tokenManagerAddress, NATIVE_INTERCHAIN_TOKEN, params);
            const tokenManager = await getContractAt('TokenManager', tokenManagerAddress, wallet);
            expect(await tokenManager.tokenAddress()).to.equal(tokenAddress);
            expect(await tokenManager.hasRole(service.address, OPERATOR_ROLE)).to.be.true;
        });
    });

    describe('Custom Token Manager Deployment', () => {
        const tokenName = 'Token Name';
        const tokenSymbol = 'TN';
        const tokenDecimals = 13;
        let token, salt, tokenId;
        let tokenManagerProxy;

        before(async () => {
            salt = getRandomBytes32();
            tokenId = await service.interchainTokenId(wallet.address, salt);
            token = await deployContract(wallet, 'TestInterchainTokenStandard', [
                tokenName,
                tokenSymbol,
                tokenDecimals,
                service.address,
                tokenId,
            ]);
        });

        it('Should revert on deploying an invalid token manager', async () => {
            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);

            await expectRevert((gasOptions) => service.deployTokenManager(salt, '', 6, params, 0, gasOptions));
        });

        it('Should revert on deploying a local token manager with invalid params', async () => {
            await expectRevert(
                (gasOptions) => service.deployTokenManager(salt, '', NATIVE_INTERCHAIN_TOKEN, '0x', 0, gasOptions),
                service,
                'EmptyParams',
            );
        });

        it('Should revert on deploying a local token manager with interchain token manager type', async () => {
            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);

            await expectRevert(
                (gasOptions) => service.deployTokenManager(salt, '', NATIVE_INTERCHAIN_TOKEN, params, 0, gasOptions),
                service,
                'CannotDeploy',
                [NATIVE_INTERCHAIN_TOKEN],
            );
        });

        it('Should revert on deploying a remote token manager with interchain token manager type', async () => {
            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);

            await expectRevert(
                (gasOptions) => service.deployTokenManager(salt, destinationChain, NATIVE_INTERCHAIN_TOKEN, params, 0, gasOptions),
                service,
                'CannotDeploy',
                [NATIVE_INTERCHAIN_TOKEN],
            );
        });

        it('Should revert on deploying a token manager if token handler post deploy fails', async () => {
            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, AddressZero]);

            await expectRevert(
                (gasOptions) => service.deployTokenManager(salt, '', LOCK_UNLOCK, params, 0, gasOptions),
                service,
                'PostDeployFailed',
            );
        });

        it('Should deploy a lock_unlock token manager', async () => {
            const tokenManagerAddress = await service.tokenManagerAddress(tokenId);
            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);

            await expect(reportGas(service.deployTokenManager(salt, '', LOCK_UNLOCK, params, 0), 'Call deployTokenManager on source chain'))
                .to.emit(service, 'InterchainTokenIdClaimed')
                .withArgs(tokenId, wallet.address, salt)
                .to.emit(service, 'TokenManagerDeployed')
                .withArgs(tokenId, tokenManagerAddress, LOCK_UNLOCK, params);

            expect(tokenManagerAddress).to.not.equal(AddressZero);
            const tokenManager = await getContractAt('TokenManager', tokenManagerAddress, wallet);

            expect(await tokenManager.isOperator(wallet.address)).to.be.true;
            expect(await tokenManager.isOperator(service.address)).to.be.true;
            expect(await tokenManager.isFlowLimiter(wallet.address)).to.be.true;
            expect(await tokenManager.isFlowLimiter(service.address)).to.be.true;

            const tokenAddress = await service.registeredTokenAddress(tokenId);
            expect(tokenAddress).to.eq(token.address);

            tokenManagerProxy = await getContractAt('TokenManagerProxy', tokenManagerAddress, wallet);

            const [implementation, tokenAddressFromProxy] = await tokenManagerProxy.getImplementationTypeAndTokenAddress();
            expect(implementation).to.eq(LOCK_UNLOCK);
            expect(tokenAddressFromProxy).to.eq(token.address);
        });

        it('Should revert when deploying a custom token manager twice', async () => {
            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);
            const revertData = keccak256(toUtf8Bytes('AlreadyDeployed()')).substring(0, 10);
            await expectRevert(
                (gasOptions) => service.deployTokenManager(salt, '', LOCK_UNLOCK, params, 0, gasOptions),
                service,
                'TokenManagerDeploymentFailed',
                [revertData],
            );
        });

        it('Should revert when calling unsupported functions directly on the token manager implementation', async () => {
            const implementationAddress = await tokenManagerProxy.implementation();
            const implementationContract = await getContractAt('TokenManager', implementationAddress, wallet);
            await expectRevert((gasOptions) => implementationContract.tokenAddress(gasOptions), implementationContract, 'NotSupported');
            await expectRevert(
                (gasOptions) => implementationContract.interchainTokenId(gasOptions),
                implementationContract,
                'NotSupported',
            );
            await expectRevert(
                (gasOptions) => implementationContract.implementationType(gasOptions),
                implementationContract,
                'NotSupported',
            );
        });

        it('Should deploy a mint_burn token manager', async () => {
            const salt = getRandomBytes32();
            const tokenId = await service.interchainTokenId(wallet.address, salt);
            const tokenManagerAddress = await service.tokenManagerAddress(tokenId);
            const token = await deployContract(wallet, 'TestInterchainTokenStandard', [
                tokenName,
                tokenSymbol,
                tokenDecimals,
                service.address,
                tokenId,
            ]);
            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);

            const tx = service.deployTokenManager(salt, '', MINT_BURN, params, 0);
            const expectedTokenManagerAddress = await service.tokenManagerAddress(tokenId);
            await expect(tx).to.emit(service, 'TokenManagerDeployed').withArgs(tokenId, expectedTokenManagerAddress, MINT_BURN, params);

            expect(tokenManagerAddress).to.not.equal(AddressZero);
            const tokenManager = await getContractAt('TokenManager', tokenManagerAddress, wallet);

            expect(await tokenManager.isOperator(wallet.address)).to.be.true;
            expect(await tokenManager.isOperator(service.address)).to.be.true;
            expect(await tokenManager.isFlowLimiter(wallet.address)).to.be.true;
            expect(await tokenManager.isFlowLimiter(service.address)).to.be.true;

            const tokenAddress = await service.registeredTokenAddress(tokenId);
            expect(tokenAddress).to.eq(token.address);

            const tokenManagerProxy = await getContractAt('TokenManagerProxy', tokenManagerAddress, wallet);

            const [implementation, tokenAddressFromProxy] = await tokenManagerProxy.getImplementationTypeAndTokenAddress();
            expect(implementation).to.eq(MINT_BURN);
            expect(tokenAddressFromProxy).to.eq(token.address);
        });

        it('Should deploy a mint_burn_from token manager', async () => {
            const salt = getRandomBytes32();
            const tokenId = await service.interchainTokenId(wallet.address, salt);
            const tokenManagerAddress = await service.tokenManagerAddress(tokenId);
            const token = await deployContract(wallet, 'TestInterchainTokenStandard', [
                tokenName,
                tokenSymbol,
                tokenDecimals,
                service.address,
                tokenId,
            ]);
            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);

            const tx = service.deployTokenManager(salt, '', MINT_BURN_FROM, params, 0);
            const expectedTokenManagerAddress = await service.tokenManagerAddress(tokenId);
            await expect(tx)
                .to.emit(service, 'TokenManagerDeployed')
                .withArgs(tokenId, expectedTokenManagerAddress, MINT_BURN_FROM, params);

            expect(tokenManagerAddress).to.not.equal(AddressZero);
            const tokenManager = await getContractAt('TokenManager', tokenManagerAddress, wallet);

            expect(await tokenManager.isOperator(wallet.address)).to.be.true;
            expect(await tokenManager.isOperator(service.address)).to.be.true;
            expect(await tokenManager.isFlowLimiter(wallet.address)).to.be.true;
            expect(await tokenManager.isFlowLimiter(service.address)).to.be.true;

            const tokenAddress = await service.registeredTokenAddress(tokenId);
            expect(tokenAddress).to.eq(token.address);

            const tokenManagerProxy = await getContractAt('TokenManagerProxy', tokenManagerAddress, wallet);

            const [implementation, tokenAddressFromProxy] = await tokenManagerProxy.getImplementationTypeAndTokenAddress();
            expect(implementation).to.eq(MINT_BURN_FROM);
            expect(tokenAddressFromProxy).to.eq(token.address);
        });

        it('Should deploy a lock_unlock_with_fee token manager', async () => {
            const salt = getRandomBytes32();
            const tokenId = await service.interchainTokenId(wallet.address, salt);
            const tokenManagerAddress = await service.tokenManagerAddress(tokenId);
            const token = await deployContract(wallet, 'TestFeeOnTransferToken', [
                tokenName,
                tokenSymbol,
                tokenDecimals,
                service.address,
                tokenId,
            ]);
            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);

            const tx = service.deployTokenManager(salt, '', LOCK_UNLOCK_FEE_ON_TRANSFER, params, 0);
            const expectedTokenManagerAddress = await service.tokenManagerAddress(tokenId);
            await expect(tx)
                .to.emit(service, 'TokenManagerDeployed')
                .withArgs(tokenId, expectedTokenManagerAddress, LOCK_UNLOCK_FEE_ON_TRANSFER, params);

            expect(tokenManagerAddress).to.not.equal(AddressZero);
            const tokenManager = await getContractAt('TokenManager', tokenManagerAddress, wallet);

            expect(await tokenManager.isOperator(wallet.address)).to.be.true;
            expect(await tokenManager.isOperator(service.address)).to.be.true;
            expect(await tokenManager.isFlowLimiter(wallet.address)).to.be.true;
            expect(await tokenManager.isFlowLimiter(service.address)).to.be.true;

            const tokenAddress = await service.registeredTokenAddress(tokenId);
            expect(tokenAddress).to.eq(token.address);

            const tokenManagerProxy = await getContractAt('TokenManagerProxy', tokenManagerAddress, wallet);

            const [implementation, tokenAddressFromProxy] = await tokenManagerProxy.getImplementationTypeAndTokenAddress();
            expect(implementation).to.eq(LOCK_UNLOCK_FEE_ON_TRANSFER);
            expect(tokenAddressFromProxy).to.eq(token.address);
        });

        it('Should revert when deploying a custom token manager if paused', async () => {
            await service.setPauseStatus(true).then((tx) => tx.wait);

            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);

            await expectRevert((gasOptions) => service.deployTokenManager(salt, '', LOCK_UNLOCK, params, 0, gasOptions), service, 'Pause');

            await service.setPauseStatus(false).then((tx) => tx.wait);
        });

        it('Should revert with NotSupported when deploying a token manager on its hub chain', async () => {
            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);

            await expect(service.setTrustedAddress(chainName, ITS_HUB_ROUTING_IDENTIFIER))
                .to.emit(service, 'TrustedAddressSet')
                .withArgs(chainName, ITS_HUB_ROUTING_IDENTIFIER);

            await expectRevert(
                (gasOptions) => service.deployTokenManager(salt, '', LOCK_UNLOCK, params, 0, gasOptions),
                service,
                'NotSupported',
            );

            await expect(service.removeTrustedAddress(chainName)).to.emit(service, 'TrustedAddressRemoved').withArgs(chainName);
        });
    });

    describe('Initialize remote custom token manager deployment', () => {
        it('Should initialize a remote custom token manager deployment', async () => {
            const salt = getRandomBytes32();

            await (
                await service.deployTokenManager(
                    salt,
                    '',
                    MINT_BURN,
                    defaultAbiCoder.encode(['bytes', 'address'], ['0x', wallet.address]),
                    0,
                )
            ).wait();

            const tokenId = await service.interchainTokenId(wallet.address, salt);
            const params = '0x1234';
            const type = LOCK_UNLOCK;
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'uint256', 'bytes'],
                [MESSAGE_TYPE_DEPLOY_TOKEN_MANAGER, tokenId, type, params],
            );

            const tokenManager = await getContractAt('TokenManager', await service.deployedTokenManager(tokenId), wallet);
            expect(await tokenManager.isOperator(AddressZero)).to.be.true;
            expect(await tokenManager.isOperator(service.address)).to.be.true;
            expect(await tokenManager.isFlowLimiter(AddressZero)).to.be.true;
            expect(await tokenManager.isFlowLimiter(service.address)).to.be.true;

            await expect(
                reportGas(
                    service.deployTokenManager(salt, destinationChain, type, params, gasValue, { value: gasValue }),
                    'Send deployTokenManager to remote chain',
                ),
            )
                .to.emit(service, 'InterchainTokenIdClaimed')
                .withArgs(tokenId, wallet.address, salt)
                .to.emit(service, 'TokenManagerDeploymentStarted')
                .withArgs(tokenId, destinationChain, type, params)
                .and.to.emit(gasService, 'NativeGasPaidForContractCall')
                .withArgs(service.address, destinationChain, service.address, keccak256(payload), gasValue, wallet.address)
                .and.to.emit(gateway, 'ContractCall')
                .withArgs(service.address, destinationChain, service.address, keccak256(payload), payload);
        });

        it('Should revert on a remote custom token manager deployment if the token manager does does not exist', async () => {
            const salt = getRandomBytes32();
            const tokenId = await service.interchainTokenId(wallet.address, salt);
            const params = '0x1234';
            const type = LOCK_UNLOCK;

            await expect(
                service.deployTokenManager(salt, destinationChain, type, params, gasValue, { value: gasValue }),
            ).to.be.revertedWithCustomError(service, 'TokenManagerDoesNotExist', [tokenId]);
        });

        it('Should revert on remote custom token manager deployment if paused', async () => {
            await service.setPauseStatus(true).then((tx) => tx.wait);

            const salt = getRandomBytes32();
            const params = '0x1234';
            const type = LOCK_UNLOCK;

            await expectRevert(
                (gasOptions) =>
                    service.deployTokenManager(salt, destinationChain, type, params, gasValue, {
                        ...gasOptions,
                        value: gasValue,
                    }),
                service,
                'Pause',
            );

            await service.setPauseStatus(false).then((tx) => tx.wait);
        });

        it('Should revert with NotSupported on deploying a remote custom token manager via its hub', async () => {
            const salt = getRandomBytes32();

            await (
                await service.deployTokenManager(
                    salt,
                    '',
                    MINT_BURN,
                    defaultAbiCoder.encode(['bytes', 'address'], ['0x', wallet.address]),
                    0,
                )
            ).wait();

            const params = '0x1234';
            const type = LOCK_UNLOCK;
            const destinationChainItsHub = 'hub chain 1';

            await expect(service.setTrustedAddress(destinationChainItsHub, ITS_HUB_ROUTING_IDENTIFIER))
                .to.emit(service, 'TrustedAddressSet')
                .withArgs(destinationChainItsHub, ITS_HUB_ROUTING_IDENTIFIER);

            await expectRevert(
                (gasOptions) => service.deployTokenManager(salt, destinationChainItsHub, type, params, gasValue, gasOptions),
                service,
                'NotSupported',
            );
        });
    });

    describe('Receive Remote Token Manager Deployment', () => {
        const tokenName = 'Token Name';
        const tokenSymbol = 'TN';
        const tokenDecimals = 13;
        let sourceAddress;

        before(async () => {
            sourceAddress = service.address;
        });

        it('Should be able to receive a remote lock/unlock token manager deployment', async () => {
            const tokenId = getRandomBytes32();
            const tokenManagerAddress = await service.tokenManagerAddress(tokenId);
            const token = await deployContract(wallet, 'TestInterchainTokenStandard', [
                tokenName,
                tokenSymbol,
                tokenDecimals,
                service.address,
                tokenId,
            ]);

            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'uint256', 'bytes'],
                [MESSAGE_TYPE_DEPLOY_TOKEN_MANAGER, tokenId, LOCK_UNLOCK, params],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);
            const expectedTokenManagerAddress = await service.tokenManagerAddress(tokenId);

            await expect(reportGas(service.execute(commandId, sourceChain, sourceAddress, payload), 'Receive GMP DEPLOY_TOKEN_MANAGER'))
                .to.emit(service, 'TokenManagerDeployed')
                .withArgs(tokenId, expectedTokenManagerAddress, LOCK_UNLOCK, params);

            const tokenManager = await getContractAt('TokenManager', tokenManagerAddress, wallet);
            expect(await tokenManager.tokenAddress()).to.equal(token.address);
            expect(await tokenManager.hasRole(wallet.address, OPERATOR_ROLE)).to.be.true;
        });

        it('Should be able to receive a remote mint/burn token manager deployment', async () => {
            const tokenId = getRandomBytes32();
            const tokenManagerAddress = await service.tokenManagerAddress(tokenId);
            const token = await deployContract(wallet, 'TestInterchainTokenStandard', [
                tokenName,
                tokenSymbol,
                tokenDecimals,
                service.address,
                tokenId,
            ]);

            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'uint256', 'bytes'],
                [MESSAGE_TYPE_DEPLOY_TOKEN_MANAGER, tokenId, MINT_BURN, params],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            const expectedTokenManagerAddress = await service.tokenManagerAddress(tokenId);
            await expect(service.execute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(service, 'TokenManagerDeployed')
                .withArgs(tokenId, expectedTokenManagerAddress, MINT_BURN, params);
            const tokenManager = await getContractAt('TokenManager', tokenManagerAddress, wallet);
            expect(await tokenManager.tokenAddress()).to.equal(token.address);
            expect(await tokenManager.hasRole(wallet.address, OPERATOR_ROLE)).to.be.true;
        });

        it('Should not be able to receive a remote interchain token manager deployment', async () => {
            const tokenId = getRandomBytes32();
            const token = await deployContract(wallet, 'TestInterchainTokenStandard', [
                tokenName,
                tokenSymbol,
                tokenDecimals,
                service.address,
                tokenId,
            ]);

            const params = defaultAbiCoder.encode(['bytes', 'address'], [wallet.address, token.address]);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'uint256', 'bytes'],
                [MESSAGE_TYPE_DEPLOY_TOKEN_MANAGER, tokenId, NATIVE_INTERCHAIN_TOKEN, params],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expectRevert(
                (gasOptions) => service.execute(commandId, sourceChain, sourceAddress, payload, gasOptions),
                service,
                'CannotDeploy',
                [NATIVE_INTERCHAIN_TOKEN],
            );
        });
    });

    describe('Send Token', () => {
        const amount = 1234;
        const destAddress = '0x5678';
        let token, tokenId;

        before(async () => {
            [token, , tokenId] = await deployFunctions.lockUnlock(service, 'Test Token lockUnlock', 'TT', 12, amount);
        });

        it('Should be able to initiate an interchain token transfer for lockUnlockFee with a normal ERC20 token', async () => {
            const [token, tokenManager, tokenId] = await deployFunctions.lockUnlockFee(
                service,
                'Test Token lockUnlockFee',
                'TT',
                12,
                amount,
                false,
                'free',
            );

            const sendAmount = amount;
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destAddress, sendAmount, '0x'],
            );
            const payloadHash = keccak256(payload);

            const transferToAddress = tokenManager.address;

            await expect(service.interchainTransfer(tokenId, destinationChain, destAddress, amount, '0x', gasValue, { value: gasValue }))
                .and.to.emit(token, 'Transfer')
                .withArgs(wallet.address, transferToAddress, amount)
                .and.to.emit(gateway, 'ContractCall')
                .withArgs(service.address, destinationChain, service.address, payloadHash, payload)
                .and.to.emit(gasService, 'NativeGasPaidForContractCall')
                .withArgs(service.address, destinationChain, service.address, payloadHash, gasValue, wallet.address)
                .to.emit(service, 'InterchainTransfer')
                .withArgs(tokenId, wallet.address, destinationChain, destAddress, sendAmount, HashZero);
        });

        it('Should revert on initiating an interchain token transfer for lockUnlockFee with reentrant token', async () => {
            const [, , tokenId] = await deployFunctions.lockUnlockFee(
                service,
                'Test Token lockUnlockFee',
                'TT',
                12,
                amount,
                false,
                'reentrant',
            );

            const revertData = keccak256(toUtf8Bytes('TokenTransferFailed()')).substring(0, 10);

            await expectRevert(
                (gasOptions) =>
                    service.interchainTransfer(tokenId, destinationChain, destAddress, amount, '0x', gasValue, {
                        ...gasOptions,
                        value: gasValue,
                    }),
                service,
                'TakeTokenFailed',
                [revertData],
            );
        });

        it('Should revert on initiate interchain token transfer with zero amount', async () => {
            await expectRevert(
                (gasOptions) =>
                    service.interchainTransfer(tokenId, destinationChain, destAddress, 0, '0x', gasValue, {
                        ...gasOptions,
                        value: gasValue,
                    }),
                service,
                'ZeroAmount',
            );
        });

        it('Should revert on initiate interchain token transfer with invalid destination address', async () => {
            await expectRevert(
                (gasOptions) =>
                    service.interchainTransfer(tokenId, destinationChain, '0x', amount, '0x', gasValue, {
                        ...gasOptions,
                        value: gasValue,
                    }),
                service,
                'EmptyDestinationAddress',
            );
        });

        it('Should revert on initiate interchain token transfer when service is paused', async () => {
            await service.setPauseStatus(true).then((tx) => tx.wait);

            await expectRevert(
                (gasOptions) =>
                    service.interchainTransfer(tokenId, destinationChain, destAddress, amount, '0x', gasValue, {
                        ...gasOptions,
                        value: gasValue,
                    }),
                service,
                'Pause',
            );
        });

        it('Should revert on transmit send token when service is paused', async () => {
            await expectRevert(
                (gasOptions) =>
                    service.transmitInterchainTransfer(tokenId, wallet.address, destinationChain, destAddress, amount, '0x', {
                        ...gasOptions,
                        value: gasValue,
                    }),
                service,
                'Pause',
            );

            await service.setPauseStatus(false).then((tx) => tx.wait);
        });

        it('Should revert on transmit send token when destination address is zero address', async () => {
            await expectRevert(
                (gasOptions) =>
                    service.transmitInterchainTransfer(tokenId, wallet.address, destinationChain, '0x', amount, '0x', {
                        ...gasOptions,
                        value: gasValue,
                    }),
                service,
                'TakeTokenFailed',
            );
        });

        it('Should revert on transmit send token when not called by interchain token', async () => {
            const errorSignatureHash = id('NotToken(address,address)');
            const selector = errorSignatureHash.substring(0, 10);
            const errorData = defaultAbiCoder.encode(['address', 'address'], [wallet.address, token.address]);

            await expectRevert(
                (gasOptions) =>
                    service.transmitInterchainTransfer(tokenId, wallet.address, destinationChain, destAddress, amount, '0x', {
                        ...gasOptions,
                        value: gasValue,
                    }),
                service,
                'TakeTokenFailed',
                [selector + errorData.substring(2)],
            );
        });
    });

    describe('Gateway call', () => {
        const amount = 1234;
        const destAddress = '0x5678';
        const data = '0x1234';
        let tokenId;
        let serviceTestGatewayCaller;

        before(async () => {
            const create3Deployer = await new ethers.ContractFactory(Create3Deployer.abi, Create3Deployer.bytecode, wallet)
                .deploy()
                .then((d) => d.deployed());

            const interchainTokenServiceAddress = await getCreate3Address(create3Deployer.address, wallet, 'InterchainTokenService');
            const tokenManager = await deployContract(wallet, 'TokenManager', [interchainTokenServiceAddress]);
            const gatewayCaller = await deployContract(wallet, 'TestGatewayCaller');
            const interchainTokenFactoryAddress = await getCreate3Address(create3Deployer.address, wallet, 'InterchainTokenServiceFactory');

            serviceTestGatewayCaller = await deployInterchainTokenService(
                wallet,
                create3Deployer.address,
                tokenManagerDeployer.address,
                interchainTokenDeployer.address,
                gateway.address,
                gasService.address,
                interchainTokenFactoryAddress,
                tokenManager.address,
                tokenHandler.address,
                gatewayCaller.address,
                'Test',
                [sourceChain, destinationChain],
                'InterchainTokenService',
            );
        });

        it('Should revert on initiating an interchain token transfer when gateway call failed', async () => {
            const [, , tokenId] = await deployFunctions.mintBurn(serviceTestGatewayCaller, 'Test Token', 'TG1', 12, amount);
            const metadata = '0x00000000';
            await expectRevert(
                (gasOptions) =>
                    serviceTestGatewayCaller.interchainTransfer(tokenId, destinationChain, destAddress, amount, metadata, gasValue, {
                        value: gasValue,
                        ...gasOptions,
                    }),
                serviceTestGatewayCaller,
                'GatewayCallFailed',
            );
        });

        it('Should revert on callContractWithInterchainToken when gateway call failed', async () => {
            [, , tokenId] = await deployFunctions.lockUnlock(serviceTestGatewayCaller, 'Test Token lockUnlock', 'TG2', 12, amount);
            await expectRevert(
                (gasOptions) =>
                    serviceTestGatewayCaller.callContractWithInterchainToken(
                        tokenId,
                        destinationChain,
                        destAddress,
                        amount,
                        data,
                        0,
                        gasOptions,
                    ),
                serviceTestGatewayCaller,
                'GatewayCallFailed',
            );
        });
    });

    describe('Execute checks', () => {
        const sourceChain = 'source chain';
        let sourceAddress;
        const amount = 1234;
        let destAddress;

        before(async () => {
            sourceAddress = service.address;
            destAddress = wallet.address;
        });

        it('Should revert on execute if remote address validation fails', async () => {
            const commandId = await approveContractCall(gateway, sourceChain, wallet.address, service.address, '0x');

            await expectRevert(
                (gasOptions) => service.execute(commandId, sourceChain, wallet.address, '0x', gasOptions),
                service,
                'NotRemoteService',
            );
        });

        it('Should revert on execute if the service is paused', async () => {
            await service.setPauseStatus(true).then((tx) => tx.wait);

            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, '0x');

            await expectRevert((gasOptions) => service.execute(commandId, sourceChain, sourceAddress, '0x', gasOptions), service, 'Pause');

            await service.setPauseStatus(false).then((tx) => tx.wait);
        });

        it('Should revert on execute with invalid messageType', async () => {
            const tokenId = getRandomBytes32();

            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'uint256'],
                [INVALID_MESSAGE_TYPE, tokenId, destAddress, amount],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expectRevert(
                (gasOptions) => service.execute(commandId, sourceChain, sourceAddress, payload, gasOptions),
                service,
                'InvalidMessageType',
                [INVALID_MESSAGE_TYPE],
            );
        });
    });

    describe('Receive Remote Tokens', () => {
        let sourceAddress;
        const amount = 1234;
        let destAddress;

        before(async () => {
            sourceAddress = service.address;
            destAddress = wallet.address;
        });

        it('Should revert with InvalidPayload', async () => {
            const invalidPayload = defaultAbiCoder
                .encode(['uint256', 'bytes'], [MESSAGE_TYPE_INTERCHAIN_TRANSFER, hexlify(wallet.address)])
                .slice(0, 32);

            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, invalidPayload);

            await expectRevert(
                (gasOptions) => service.execute(commandId, sourceChain, sourceAddress, invalidPayload, gasOptions),
                service,
                'InvalidPayload',
            );
        });

        it('Should be able to receive lock/unlock token', async () => {
            const [token, tokenManager, tokenId] = await deployFunctions.lockUnlock(service, 'Test Token Lock Unlock', 'TT', 12, amount);
            await token.transfer(tokenManager.address, amount).then((tx) => tx.wait);

            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destAddress, amount, '0x'],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expect(
                reportGas(service.execute(commandId, sourceChain, sourceAddress, payload), 'Receive GMP INTERCHAIN_TRANSFER lock/unlock'),
            )
                .to.emit(token, 'Transfer')
                .withArgs(tokenManager.address, destAddress, amount)
                .and.to.emit(service, 'InterchainTransferReceived')
                .withArgs(commandId, tokenId, sourceChain, hexlify(wallet.address), destAddress, amount, HashZero);
        });

        it('Should be able to receive mint/burn token', async () => {
            const [token, , tokenId] = await deployFunctions.mintBurn(service, 'Test Token Mint Burn', 'TT', 12, 0);

            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destAddress, amount, '0x'],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expect(
                reportGas(service.execute(commandId, sourceChain, sourceAddress, payload), 'Receive GMP INTERCHAIN_TRANSFER mint/burn'),
            )
                .to.emit(token, 'Transfer')
                .withArgs(AddressZero, destAddress, amount)
                .and.to.emit(service, 'InterchainTransferReceived')
                .withArgs(commandId, tokenId, sourceChain, hexlify(wallet.address), destAddress, amount, HashZero);
        });

        it('Should be able to receive lock/unlock with fee on transfer token', async () => {
            const [token, tokenManager, tokenId] = await deployFunctions.lockUnlockFee(
                service,
                'Test Token Lock Unlock',
                'TT',
                12,
                amount + 10,
            );
            await token.transfer(tokenManager.address, amount + 10).then((tx) => tx.wait);

            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destAddress, amount, '0x'],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expect(service.execute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(token, 'Transfer')
                .withArgs(tokenManager.address, destAddress, amount)
                .and.to.emit(service, 'InterchainTransferReceived')
                .withArgs(commandId, tokenId, sourceChain, hexlify(wallet.address), destAddress, amount - 10, HashZero);
        });

        it('Should be able to receive lock/unlock with fee on transfer token with normal ERC20 token', async () => {
            const [token, tokenManager, tokenId] = await deployFunctions.lockUnlockFee(
                service,
                'Test Token Lock Unlock',
                'TT',
                12,
                amount,
                false,
                'free',
            );
            await token.transfer(tokenManager.address, amount).then((tx) => tx.wait);

            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destAddress, amount, '0x'],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expect(service.execute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(token, 'Transfer')
                .withArgs(tokenManager.address, destAddress, amount)
                .and.to.emit(service, 'InterchainTransferReceived')
                .withArgs(commandId, tokenId, sourceChain, hexlify(wallet.address), destAddress, amount, HashZero);
        });
    });

    describe('Send Token With Data', () => {
        const amount = 1234;
        const destAddress = '0x5678';
        const data = '0x1234';
        let sourceAddress;
        let token, tokenManager, tokenId;

        before(async () => {
            sourceAddress = wallet.address;
            [token, tokenManager, tokenId] = await deployFunctions.lockUnlock(service, 'Test Token lockUnlock', 'TT', 12, amount);
        });

        it('Should revert on an interchain transfer if service is paused', async () => {
            await service.setPauseStatus(true).then((tx) => tx.wait);

            const tokenId = getRandomBytes32();

            await expectRevert(
                (gasOptions) =>
                    service.callContractWithInterchainToken(tokenId, destinationChain, destAddress, amount, data, 0, gasOptions),
                service,
                'Pause',
            );

            await service.setPauseStatus(false).then((tx) => tx.wait);
        });

        for (const type of ['lockUnlock', 'mintBurn', 'lockUnlockFee', 'mintBurnFrom']) {
            it(`Should initiate an interchain token transfer via the interchainTransfer standard contract call & express call [${type}]`, async () => {
                const [token, tokenManager, tokenId] = await deployFunctions[type](service, `Test Token ${type}`, 'TT', 12, amount * 2);
                const sendAmount = type === 'lockUnlockFee' ? amount - 10 : amount;
                const metadata = '0x00000000';
                const payload = defaultAbiCoder.encode(
                    ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                    [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddress, destAddress, sendAmount, '0x'],
                );
                const payloadHash = keccak256(payload);

                const metadataExpress = '0x00000001';

                let transferToAddress = AddressZero;

                if (type === 'lockUnlock' || type === 'lockUnlockFee') {
                    transferToAddress = tokenManager.address;
                }

                if (type === 'mintBurnFrom') {
                    const txApprove = await token.approve(service.address, amount * 2);
                    await txApprove.wait();
                }

                await expect(
                    reportGas(
                        service.interchainTransfer(tokenId, destinationChain, destAddress, amount, metadata, gasValue, { value: gasValue }),
                        `Call service.interchainTransfer with metadata ${type}`,
                    ),
                )
                    .to.emit(token, 'Transfer')
                    .withArgs(wallet.address, transferToAddress, amount)
                    .and.to.emit(gateway, 'ContractCall')
                    .withArgs(service.address, destinationChain, service.address, payloadHash, payload)
                    .and.to.emit(gasService, 'NativeGasPaidForContractCall')
                    .withArgs(service.address, destinationChain, service.address, payloadHash, gasValue, wallet.address)
                    .to.emit(service, 'InterchainTransfer')
                    .withArgs(tokenId, sourceAddress, destinationChain, destAddress, sendAmount, HashZero);

                await expect(
                    reportGas(
                        service.interchainTransfer(tokenId, destinationChain, destAddress, amount, metadataExpress, gasValue, {
                            value: gasValue,
                        }),
                        `Call service.interchainTransfer with metadata ${type} (express call)`,
                    ),
                )
                    .to.emit(token, 'Transfer')
                    .withArgs(wallet.address, transferToAddress, amount)
                    .and.to.emit(gateway, 'ContractCall')
                    .withArgs(service.address, destinationChain, service.address, payloadHash, payload)
                    .and.to.emit(gasService, 'NativeGasPaidForExpressCall')
                    .withArgs(service.address, destinationChain, service.address, payloadHash, gasValue, wallet.address)
                    .to.emit(service, 'InterchainTransfer')
                    .withArgs(tokenId, sourceAddress, destinationChain, destAddress, sendAmount, HashZero);
            });
        }

        it('Should revert on callContractWithInterchainToken function on the service if amount is 0', async () => {
            const [, , tokenId] = await deployFunctions.lockUnlock(service, 'Test Token', 'TT', 12, amount);

            await expectRevert(
                (gasOptions) => service.callContractWithInterchainToken(tokenId, destinationChain, destAddress, 0, data, 0, gasOptions),
                service,
                'ZeroAmount',
            );
        });

        it('Should revert on callContractWithInterchainToken function on the service with invalid destination address', async () => {
            const [, , tokenId] = await deployFunctions.lockUnlock(service, 'Test Token', 'TT', 12, amount);

            await expectRevert(
                (gasOptions) => service.callContractWithInterchainToken(tokenId, destinationChain, '0x', amount, data, 0, gasOptions),
                service,
                'EmptyDestinationAddress',
            );
        });

        for (const type of ['lockUnlock', 'lockUnlockFee']) {
            it(`Should be able to initiate an interchain token transfer via the interchainTransfer function on the service when the service is approved as well [${type}]`, async () => {
                const [token, tokenManager, tokenId] = await deployFunctions[type](service, `Test Token ${type}`, 'TT', 12, amount);
                const sendAmount = type === 'lockUnlockFee' ? amount - 10 : amount;
                const metadata = '0x00000000';
                const payload = defaultAbiCoder.encode(
                    ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                    [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddress, destAddress, sendAmount, '0x'],
                );
                const payloadHash = keccak256(payload);

                const transferToAddress = tokenManager.address;

                await token.approve(service.address, amount).then((tx) => tx.wait);
                await token.approve(tokenManager.address, 0).then((tx) => tx.wait);

                await expect(
                    reportGas(
                        service.interchainTransfer(tokenId, destinationChain, destAddress, amount, metadata, 0),
                        `Call service.interchainTransfer with metadata ${type}`,
                    ),
                )
                    .to.emit(token, 'Transfer')
                    .withArgs(wallet.address, transferToAddress, amount)
                    .and.to.emit(gateway, 'ContractCall')
                    .withArgs(service.address, destinationChain, service.address, payloadHash, payload)
                    .to.emit(service, 'InterchainTransfer')
                    .withArgs(tokenId, sourceAddress, destinationChain, destAddress, sendAmount, HashZero);
            });
        }

        for (const type of ['lockUnlock', 'mintBurn', 'lockUnlockFee']) {
            it(`Should be able to initiate an interchain token transfer via the callContractWithInterchainToken function on the service [${type}]`, async () => {
                const [token, tokenManager, tokenId] = await deployFunctions[type](service, `Test Token ${type}`, 'TT', 12, amount);
                const sendAmount = type === 'lockUnlockFee' ? amount - 10 : amount;
                const payload = defaultAbiCoder.encode(
                    ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                    [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddress, destAddress, sendAmount, data],
                );
                const payloadHash = keccak256(payload);

                let transferToAddress = AddressZero;

                if (type === 'lockUnlock' || type === 'lockUnlockFee') {
                    transferToAddress = tokenManager.address;
                }

                await expect(
                    reportGas(
                        service.callContractWithInterchainToken(tokenId, destinationChain, destAddress, amount, data, 0, {
                            value: gasValue,
                        }),
                        `Call service.callContractWithInterchainToken ${type}`,
                    ),
                )
                    .and.to.emit(token, 'Transfer')
                    .withArgs(wallet.address, transferToAddress, amount)
                    .and.to.emit(gateway, 'ContractCall')
                    .withArgs(service.address, destinationChain, service.address, payloadHash, payload)
                    .to.emit(service, 'InterchainTransfer')
                    .withArgs(tokenId, sourceAddress, destinationChain, destAddress, sendAmount, keccak256(data));
            });
        }

        it('Should revert on callContractWithInterchainToken if data is empty', async () => {
            const tokenId = HashZero;
            const invalidData = '0x';

            await expectRevert(
                (gasOptions) =>
                    service.callContractWithInterchainToken(tokenId, destinationChain, destAddress, amount, invalidData, 0, gasOptions),
                service,
                'EmptyData',
            );
        });

        it('Should revert on callContractWithInterchainToken function when service is paused', async () => {
            const tokenId = HashZero;

            await service.setPauseStatus(true).then((tx) => tx.wait);

            await expectRevert(
                (gasOptions) =>
                    service.callContractWithInterchainToken(tokenId, destinationChain, destAddress, amount, data, 0, gasOptions),
                service,
                'Pause',
            );
        });

        it('Should revert on interchainTransfer function when service is paused', async () => {
            const metadata = '0x';
            const tokenId = HashZero;

            await expectRevert(
                (gasOptions) => service.interchainTransfer(tokenId, destinationChain, destAddress, amount, metadata, 0, gasOptions),
                service,
                'Pause',
            );

            await service.setPauseStatus(false).then((tx) => tx.wait);
        });

        it('Should revert on transferToTokenManager when not called by the correct tokenManager', async () => {
            const from = otherWallet.address;

            expectRevert(
                (gasOptions) => service.transferToTokenManager(tokenId, token.address, from, amount, gasOptions),
                service,
                'NotTokenManager',
                [wallet.address, tokenManager.address],
            );
        });

        it('Should revert on interchainTransfer function with invalid metadata version', async () => {
            const metadata = '0x00000002';

            await expectRevert(
                (gasOptions) => service.interchainTransfer(tokenId, destinationChain, destAddress, amount, metadata, 0, gasOptions),
                service,
                'InvalidMetadataVersion',
                [Number(metadata)],
            );
        });

        it('Should revert on callContractWithInterchainToken when destination chain is untrusted chain', async () => {
            const type = 'lockUnlock';
            const [, , tokenId] = await deployFunctions[type](service, `Test Token ${type}`, 'TT', 12, amount);
            await expectRevert(
                (gasOptions) =>
                    service.callContractWithInterchainToken(tokenId, ITS_HUB_CHAIN_NAME, destAddress, amount, data, 0, gasOptions),
                service,
                'UntrustedChain',
            );
        });
    });

    describe('Receive Remote Token with Data', () => {
        let sourceAddress;
        const sourceAddressForService = '0x1234';
        const amount = 1234;
        let destAddress;
        let executable;
        let invalidExecutable;

        before(async () => {
            sourceAddress = service.address;
            executable = await deployContract(wallet, 'TestInterchainExecutable', [service.address]);
            invalidExecutable = await deployContract(wallet, 'TestInvalidInterchainExecutable', [service.address]);
            destAddress = executable.address;
        });

        it('Should be able to receive lock/unlock token', async () => {
            const [token, tokenManager, tokenId] = await deployFunctions.lockUnlock(service, 'Test Token Lock Unlock', 'TT', 12, amount);
            await token.transfer(tokenManager.address, amount).then((tx) => tx.wait);
            const msg = 'lock/unlock';
            const data = defaultAbiCoder.encode(['address', 'string'], [wallet.address, msg]);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddressForService, destAddress, amount, data],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expect(service.execute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(token, 'Transfer')
                .withArgs(tokenManager.address, destAddress, amount)
                .to.emit(token, 'Transfer')
                .withArgs(destAddress, wallet.address, amount)
                .and.to.emit(service, 'InterchainTransferReceived')
                .withArgs(commandId, tokenId, sourceChain, sourceAddressForService, destAddress, amount, keccak256(data))
                .and.to.emit(executable, 'MessageReceived')
                .withArgs(commandId, sourceChain, sourceAddressForService, wallet.address, msg, tokenId, amount);

            expect(await executable.lastMessage()).to.equal(msg);
        });

        it('Should be able to receive lock/unlock token with empty data and not call destination contract', async () => {
            const [token, tokenManager, tokenId] = await deployFunctions.lockUnlock(service, 'Test Token Lock Unlock', 'TT', 12, amount);
            await token.transfer(tokenManager.address, amount).then((tx) => tx.wait);

            const data = '0x';
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddressForService, destAddress, amount, data],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expect(service.execute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(token, 'Transfer')
                .withArgs(tokenManager.address, destAddress, amount)
                .and.to.emit(service, 'InterchainTransferReceived')
                .withArgs(commandId, tokenId, sourceChain, sourceAddressForService, destAddress, amount, HashZero)
                .and.to.not.emit(executable, 'MessageReceived');
        });

        it('Should be able to receive mint/burn token', async () => {
            const [token, , tokenId] = await deployFunctions.mintBurn(service, 'Test Token Mint Burn', 'TT', 12, amount);

            const msg = 'mint/burn';
            const data = defaultAbiCoder.encode(['address', 'string'], [wallet.address, msg]);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddressForService, destAddress, amount, data],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expect(
                reportGas(
                    service.execute(commandId, sourceChain, sourceAddress, payload),
                    'Receive GMP INTERCHAIN_TRANSFER_WITH_DATA mint/burn',
                ),
            )
                .to.emit(token, 'Transfer')
                .withArgs(AddressZero, destAddress, amount)
                .to.emit(token, 'Transfer')
                .withArgs(destAddress, wallet.address, amount)
                .and.to.emit(service, 'InterchainTransferReceived')
                .withArgs(commandId, tokenId, sourceChain, sourceAddressForService, destAddress, amount, keccak256(data))
                .and.to.emit(executable, 'MessageReceived')
                .withArgs(commandId, sourceChain, sourceAddressForService, wallet.address, msg, tokenId, amount);

            expect(await executable.lastMessage()).to.equal(msg);
        });

        it('Should be able to receive mint/burn from token', async () => {
            const [token, , tokenId] = await deployFunctions.mintBurnFrom(service, 'Test Token Mint Burn From', 'TT', 12, amount);

            const msg = 'mint/burn';
            const data = defaultAbiCoder.encode(['address', 'string'], [wallet.address, msg]);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddressForService, destAddress, amount, data],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expect(
                reportGas(
                    service.execute(commandId, sourceChain, sourceAddress, payload),
                    'Receive GMP INTERCHAIN_TRANSFER_WITH_DATA mint/burn from',
                ),
            )
                .to.emit(token, 'Transfer')
                .withArgs(AddressZero, destAddress, amount)
                .to.emit(token, 'Transfer')
                .withArgs(destAddress, wallet.address, amount)
                .and.to.emit(service, 'InterchainTransferReceived')
                .withArgs(commandId, tokenId, sourceChain, sourceAddressForService, destAddress, amount, keccak256(data))
                .and.to.emit(executable, 'MessageReceived')
                .withArgs(commandId, sourceChain, sourceAddressForService, wallet.address, msg, tokenId, amount);

            expect(await executable.lastMessage()).to.equal(msg);
        });

        it('Should be able to receive lock/unlock with fee on transfer token', async () => {
            const [token, tokenManager, tokenId] = await deployFunctions.lockUnlockFee(
                service,
                'Test Token Lock Unlock',
                'TT',
                12,
                amount + 10,
            );
            await token.transfer(tokenManager.address, amount + 10).then((tx) => tx.wait);
            const msg = 'lock/unlock';
            const data = defaultAbiCoder.encode(['address', 'string'], [wallet.address, msg]);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddressForService, destAddress, amount, data],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expect(service.execute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(token, 'Transfer')
                .withArgs(tokenManager.address, destAddress, amount)
                .to.emit(token, 'Transfer')
                .withArgs(destAddress, wallet.address, amount - 10)
                .and.to.emit(service, 'InterchainTransferReceived')
                .withArgs(commandId, tokenId, sourceChain, sourceAddressForService, destAddress, amount - 10, keccak256(data))
                .and.to.emit(executable, 'MessageReceived')
                .withArgs(commandId, sourceChain, sourceAddressForService, wallet.address, msg, tokenId, amount - 10);

            expect(await executable.lastMessage()).to.equal(msg);
        });

        it('Should revert if token handler transfer token from fails', async () => {
            const [token, tokenManager, tokenId] = await deployFunctions.lockUnlock(service, 'Test Token Lock Unlock', 'TT', 12, amount);
            await token.transfer(tokenManager.address, amount).then((tx) => tx.wait);
            const msg = 'lock/unlock';
            const data = defaultAbiCoder.encode(['address', 'string'], [wallet.address, msg]);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddressForService, AddressZero, amount, data],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            const errorSignatureHash = id('TokenTransferFailed()');
            const errorData = errorSignatureHash.substring(0, 10);

            await expectRevert(
                (gasOptions) => service.execute(commandId, sourceChain, sourceAddress, payload, gasOptions),
                service,
                'GiveTokenFailed',
                [errorData],
            );
        });

        it('Should revert if execute with interchain token fails', async () => {
            const [token, tokenManager, tokenId] = await deployFunctions.lockUnlock(service, 'Test Token Lock Unlock', 'TT', 12, amount);
            await token.transfer(tokenManager.address, amount).then((tx) => tx.wait);
            const msg = 'lock/unlock';
            const data = defaultAbiCoder.encode(['address', 'string'], [wallet.address, msg]);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddressForService, invalidExecutable.address, amount, data],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expectRevert(
                (gasOptions) => service.execute(commandId, sourceChain, sourceAddress, payload, gasOptions),
                service,
                'ExecuteWithInterchainTokenFailed',
                [invalidExecutable.address],
            );
        });

        it('Should revert with UntrustedChain when the message type is RECEIVE_FROM_HUB and untrusted chain', async () => {
            const data = '0x';
            const payload = defaultAbiCoder.encode(['uint256', 'bytes'], [MESSAGE_TYPE_RECEIVE_FROM_HUB, data]);
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expectRevert(
                (gasOptions) => service.execute(commandId, sourceChain, sourceAddress, payload, gasOptions),
                service,
                'UntrustedChain',
            );
        });

        it('Should revert with UntrustedChain when the message type is RECEIVE_FROM_HUB and untrusted original source chain', async () => {
            const data = '0x';
            const payload = defaultAbiCoder.encode(
                ['uint256', 'string', 'bytes'],
                [MESSAGE_TYPE_RECEIVE_FROM_HUB, 'untrustedSourceChain', data],
            );
            const commandId = await approveContractCall(gateway, ITS_HUB_CHAIN_NAME, ITS_HUB_ADDRESS, service.address, payload);

            await expect(service.setTrustedAddress(ITS_HUB_CHAIN_NAME, ITS_HUB_ADDRESS))
                .to.emit(service, 'TrustedAddressSet')
                .withArgs(ITS_HUB_CHAIN_NAME, ITS_HUB_ADDRESS);

            await expectRevert(
                (gasOptions) => service.execute(commandId, ITS_HUB_CHAIN_NAME, ITS_HUB_ADDRESS, payload, gasOptions),
                service,
                'UntrustedChain',
            );
        });

        it('Should revert with InvalidPayload when the message type is RECEIVE_FROM_HUB and has invalid inner payload.', async () => {
            const data = '0x';
            const sourceChain = 'hub chain 1';
            const invalidItsMessage = defaultAbiCoder
                .encode(['uint256', 'uint256', 'bytes'], [MESSAGE_TYPE_INTERCHAIN_TRANSFER, amount, data])
                .slice(0, 32);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'string', 'bytes'],
                [MESSAGE_TYPE_RECEIVE_FROM_HUB, sourceChain, invalidItsMessage],
            );
            const commandId = await approveContractCall(gateway, ITS_HUB_CHAIN_NAME, ITS_HUB_ADDRESS, service.address, payload);

            await expect(service.setTrustedAddress(sourceChain, ITS_HUB_ROUTING_IDENTIFIER))
                .to.emit(service, 'TrustedAddressSet')
                .withArgs(sourceChain, ITS_HUB_ROUTING_IDENTIFIER);

            await expectRevert(
                (gasOptions) => service.execute(commandId, ITS_HUB_CHAIN_NAME, ITS_HUB_ADDRESS, payload, gasOptions),
                service,
                'InvalidPayload',
            );
        });

        it('Should revert with NotSupported when the message type is RECEIVE_FROM_HUB and has MESSAGE_TYPE_DEPLOY_TOKEN_MANAGER type.', async () => {
            const salt = getRandomBytes32();

            await (
                await service.deployTokenManager(
                    salt,
                    '',
                    MINT_BURN,
                    defaultAbiCoder.encode(['bytes', 'address'], ['0x', wallet.address]),
                    0,
                )
            ).wait();

            const tokenId = await service.interchainTokenId(wallet.address, salt);
            const params = '0x1234';
            const type = LOCK_UNLOCK;
            const sourceChain = 'hub chain 1';
            const itsMessage = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'uint256', 'bytes'],
                [MESSAGE_TYPE_DEPLOY_TOKEN_MANAGER, tokenId, type, params],
            );
            const payload = defaultAbiCoder.encode(
                ['uint256', 'string', 'bytes'],
                [MESSAGE_TYPE_RECEIVE_FROM_HUB, sourceChain, itsMessage],
            );
            const commandId = await approveContractCall(gateway, ITS_HUB_CHAIN_NAME, ITS_HUB_ADDRESS, service.address, payload);

            await expect(service.setTrustedAddress(sourceChain, ITS_HUB_ROUTING_IDENTIFIER))
                .to.emit(service, 'TrustedAddressSet')
                .withArgs(sourceChain, ITS_HUB_ROUTING_IDENTIFIER);

            await expectRevert(
                (gasOptions) => service.execute(commandId, ITS_HUB_CHAIN_NAME, ITS_HUB_ADDRESS, payload, gasOptions),
                service,
                'NotSupported',
            );
        });

        it('Should revert with UntrustedChain when receiving a direct message from the ITS Hub. Not supported yet', async () => {
            const data = '0x';
            const payload = defaultAbiCoder.encode(['uint256', 'bytes'], [MESSAGE_TYPE_INTERCHAIN_TRANSFER, data]);

            const commandId = await approveContractCall(gateway, ITS_HUB_CHAIN_NAME, ITS_HUB_ADDRESS, service.address, payload);

            await expect(service.setTrustedAddress(ITS_HUB_CHAIN_NAME, ITS_HUB_ADDRESS))
                .to.emit(service, 'TrustedAddressSet')
                .withArgs(ITS_HUB_CHAIN_NAME, ITS_HUB_ADDRESS);

            await expectRevert(
                (gasOptions) => service.execute(commandId, ITS_HUB_CHAIN_NAME, ITS_HUB_ADDRESS, payload, gasOptions),
                service,
                'UntrustedChain',
            );
        });
    });

    describe('Send Interchain Token', () => {
        const amount = 1234;
        const destAddress = '0x5678';
        const metadata = '0x';
        let token, tokenManager, tokenId;

        for (const type of ['mintBurn', 'mintBurnFrom', 'lockUnlockFee', 'lockUnlock']) {
            it(`Should be able to initiate an interchain token transfer via interchainTransfer & interchainTransferFrom [${type}]`, async () => {
                [token, tokenManager, tokenId] = await deployFunctions[type](service, `Test Token ${type}`, 'TT', 12, amount * 3, true);
                const sendAmount = type === 'lockUnlockFee' ? amount - 10 : amount;
                const payload = defaultAbiCoder.encode(
                    ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                    [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destAddress, sendAmount, '0x'],
                );
                const payloadHash = keccak256(payload);

                let transferToAddress = AddressZero;

                if (type === 'lockUnlock' || type === 'lockUnlockFee') {
                    transferToAddress = tokenManager.address;
                }

                await expect(
                    reportGas(
                        token.connect(wallet).interchainTransfer(destinationChain, destAddress, amount, metadata, { value: gasValue }),
                        `Call token.interchainTransfer ${type}`,
                    ),
                )
                    .and.to.emit(token, 'Transfer')
                    .withArgs(wallet.address, transferToAddress, amount)
                    .and.to.emit(gateway, 'ContractCall')
                    .withArgs(service.address, destinationChain, service.address, payloadHash, payload)
                    .and.to.emit(gasService, 'NativeGasPaidForContractCall')
                    .withArgs(service.address, destinationChain, service.address, payloadHash, gasValue, wallet.address)
                    .to.emit(service, 'InterchainTransfer')
                    .withArgs(tokenId, wallet.address, destinationChain, destAddress, sendAmount, HashZero);

                await token.approve(otherWallet.address, amount).then((tx) => tx.wait);

                await expect(
                    token
                        .connect(otherWallet)
                        .interchainTransferFrom(wallet.address, destinationChain, destAddress, amount, metadata, { value: gasValue }),
                )
                    .and.to.emit(token, 'Transfer')
                    .withArgs(wallet.address, transferToAddress, amount)
                    .and.to.emit(gateway, 'ContractCall')
                    .withArgs(service.address, destinationChain, service.address, payloadHash, payload)
                    .and.to.emit(gasService, 'NativeGasPaidForContractCall')
                    .withArgs(service.address, destinationChain, service.address, payloadHash, gasValue, otherWallet.address)
                    .to.emit(service, 'InterchainTransfer')
                    .withArgs(tokenId, wallet.address, destinationChain, destAddress, sendAmount, HashZero);
            });
        }

        for (const type of ['mintBurn', 'mintBurnFrom', 'lockUnlockFee', 'lockUnlock']) {
            it(`Should be able to initiate an interchain token transfer via interchainTransfer [${type}] without native gas`, async () => {
                [token, tokenManager, tokenId] = await deployFunctions[type](service, `Test Token ${type}`, 'TT', 12, amount * 3, true);
                const sendAmount = type === 'lockUnlockFee' ? amount - 10 : amount;
                const payload = defaultAbiCoder.encode(
                    ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                    [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destAddress, sendAmount, '0x'],
                );
                const payloadHash = keccak256(payload);

                let transferToAddress = AddressZero;

                if (type === 'lockUnlock' || type === 'lockUnlockFee') {
                    transferToAddress = tokenManager.address;
                }

                await expect(
                    reportGas(
                        token.connect(wallet).interchainTransfer(destinationChain, destAddress, amount, metadata),
                        `Call token.interchainTransfer ${type}`,
                    ),
                )
                    .and.to.emit(token, 'Transfer')
                    .withArgs(wallet.address, transferToAddress, amount)
                    .and.to.emit(gateway, 'ContractCall')
                    .withArgs(service.address, destinationChain, service.address, payloadHash, payload)
                    .to.emit(service, 'InterchainTransfer')
                    .withArgs(tokenId, wallet.address, destinationChain, destAddress, sendAmount, HashZero);
            });
        }

        it('Should be able to initiate an interchain token transfer using interchainTransferFrom with max possible allowance', async () => {
            const sendAmount = amount;
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destAddress, sendAmount, '0x'],
            );
            const payloadHash = keccak256(payload);

            const transferToAddress = tokenManager.address;

            const sender = wallet;
            const spender = otherWallet;
            await token.approve(spender.address, MaxUint256).then((tx) => tx.wait);

            await expect(
                reportGas(
                    token
                        .connect(spender)
                        .interchainTransferFrom(sender.address, destinationChain, destAddress, amount, metadata, { value: gasValue }),
                    'Call token.interchainTransferFrom lock/unlock',
                ),
            )
                .and.to.emit(token, 'Transfer')
                .withArgs(wallet.address, transferToAddress, amount)
                .and.to.emit(gateway, 'ContractCall')
                .withArgs(service.address, destinationChain, service.address, payloadHash, payload)
                .and.to.emit(gasService, 'NativeGasPaidForContractCall')
                .withArgs(service.address, destinationChain, service.address, payloadHash, gasValue, spender.address)
                .to.emit(service, 'InterchainTransfer')
                .withArgs(tokenId, sender.address, destinationChain, destAddress, sendAmount, HashZero);
        });

        it('Should revert using interchainTransferFrom with zero amount', async () => {
            const sender = wallet;
            const spender = otherWallet;
            await token.approve(spender.address, MaxUint256).then((tx) => tx.wait);

            await expectRevert(
                (gasOptions) =>
                    token.connect(spender).interchainTransferFrom(sender.address, destinationChain, destAddress, 0, metadata, {
                        value: gasValue,
                        ...gasOptions,
                    }),
                service,
                'ZeroAmount',
            );
        });
    });

    describe('Send Interchain Token With Data', () => {
        const amount = 1234;
        const destAddress = '0x5678';
        let sourceAddress;
        const data = '0x1234';

        before(() => {
            sourceAddress = wallet.address;
        });

        for (const type of ['lockUnlock', 'mintBurn', 'mintBurnFrom', 'lockUnlockFee']) {
            it(`Should be able to initiate an interchain token transfer [${type}]`, async () => {
                const [token, tokenManager, tokenId] = await deployFunctions[type](service, `Test Token ${type}`, 'TT', 12, amount, false);
                const sendAmount = type === 'lockUnlockFee' ? amount - 10 : amount;

                const payload = defaultAbiCoder.encode(
                    ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                    [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddress, destAddress, sendAmount, data],
                );
                const payloadHash = keccak256(payload);

                let transferToAddress = AddressZero;

                if (type === 'lockUnlock' || type === 'lockUnlockFee') {
                    transferToAddress = tokenManager.address;
                }

                const metadata = solidityPack(['uint32', 'bytes'], [0, data]);
                await expect(token.interchainTransfer(destinationChain, destAddress, amount, metadata, { value: gasValue }))
                    .and.to.emit(token, 'Transfer')
                    .withArgs(wallet.address, transferToAddress, amount)
                    .and.to.emit(gateway, 'ContractCall')
                    .withArgs(service.address, destinationChain, service.address, payloadHash, payload)
                    .and.to.emit(gasService, 'NativeGasPaidForContractCall')
                    .withArgs(service.address, destinationChain, service.address, payloadHash, gasValue, wallet.address)
                    .to.emit(service, 'InterchainTransfer')
                    .withArgs(tokenId, sourceAddress, destinationChain, destAddress, sendAmount, keccak256(data));
            });
        }
    });

    describe('Express Execute', () => {
        const commandId = getRandomBytes32();
        const sourceAddress = '0x1234';
        const amount = 1234;
        const destinationAddress = new Wallet(getRandomBytes32()).address;
        const tokenName = 'name';
        const tokenSymbol = 'symbol';
        const tokenDecimals = 16;
        const message = 'message';
        let data;
        let tokenId;
        let executable;
        let invalidExecutable;
        let token;

        before(async () => {
            [token, , tokenId] = await deployFunctions.lockUnlock(service, tokenName, tokenSymbol, tokenDecimals, amount * 2, true);
            await token.approve(service.address, amount * 2).then((tx) => tx.wait);
            data = defaultAbiCoder.encode(['address', 'string'], [destinationAddress, message]);
            executable = await deployContract(wallet, 'TestInterchainExecutable', [service.address]);
            invalidExecutable = await deployContract(wallet, 'TestInvalidInterchainExecutable', [service.address]);
        });

        it('Should revert on executeWithInterchainToken when not called by the service', async () => {
            await expectRevert(
                (gasOptions) =>
                    executable.executeWithInterchainToken(
                        commandId,
                        sourceChain,
                        sourceAddress,
                        data,
                        tokenId,
                        token.address,
                        amount,
                        gasOptions,
                    ),
                executable,
                'NotService',
                [wallet.address],
            );
        });

        it('Should revert on expressExecuteWithInterchainToken when not called by the service', async () => {
            await expectRevert(
                (gasOptions) =>
                    executable.expressExecuteWithInterchainToken(
                        commandId,
                        sourceChain,
                        sourceAddress,
                        data,
                        tokenId,
                        token.address,
                        amount,
                        gasOptions,
                    ),
                executable,
                'NotService',
                [wallet.address],
            );
        });

        it('Should revert on express execute when service is paused', async () => {
            const payload = '0x';

            await service.setPauseStatus(true).then((tx) => tx.wait);

            await expectRevert(
                (gasOptions) => service.expressExecute(commandId, sourceChain, sourceAddress, payload, gasOptions),
                service,
                'Pause',
            );

            await service.setPauseStatus(false).then((tx) => tx.wait);
        });

        it('Should express execute', async () => {
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destinationAddress, amount, '0x'],
            );
            await expect(service.expressExecute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(service, 'ExpressExecuted')
                .withArgs(commandId, sourceChain, sourceAddress, keccak256(payload), wallet.address)
                .and.to.emit(token, 'Transfer')
                .withArgs(wallet.address, destinationAddress, amount);
        });

        it('Should revert on express execute if token handler transfer token from fails', async () => {
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', ' bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddress, AddressZero, amount, data],
            );

            const errorSignatureHash = id('TokenTransferFailed()');
            const errorData = errorSignatureHash.substring(0, 10);

            await expectRevert(
                (gasOptions) => service.expressExecute(commandId, sourceChain, sourceAddress, payload, gasOptions),
                service,
                'TokenHandlerFailed',
                [errorData],
            );
        });

        it('Should revert on express execute with token if token transfer fails on destination chain', async () => {
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', ' bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddress, invalidExecutable.address, amount, data],
            );

            await expectRevert(
                (gasOptions) => service.expressExecute(commandId, sourceChain, sourceAddress, payload, gasOptions),
                service,
                'ExpressExecuteWithInterchainTokenFailed',
                [invalidExecutable.address],
            );
        });

        it('Should express execute with token', async () => {
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', ' bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddress, executable.address, amount, data],
            );
            await expect(service.expressExecute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(service, 'ExpressExecuted')
                .withArgs(commandId, sourceChain, sourceAddress, keccak256(payload), wallet.address)
                .and.to.emit(token, 'Transfer')
                .withArgs(wallet.address, executable.address, amount)
                .and.to.emit(token, 'Transfer')
                .withArgs(executable.address, destinationAddress, amount)
                .and.to.emit(executable, 'MessageReceived')
                .withArgs(commandId, sourceChain, sourceAddress, destinationAddress, message, tokenId, amount);
        });
    });

    describe('Interchain Executable', () => {
        const commandId = getRandomBytes32();
        const sourceAddress = '0x1234';
        const amount = 1234;
        const destinationAddress = new Wallet(getRandomBytes32()).address;
        const tokenName = 'name';
        const tokenSymbol = 'symbol';
        const tokenDecimals = 16;
        const message = 'message';
        let data;
        let tokenId;
        let executable;
        let token;

        before(async () => {
            [token, , tokenId] = await deployFunctions.mintBurn(service, tokenName, tokenSymbol, tokenDecimals, amount * 2, true);
            data = defaultAbiCoder.encode(['address', 'string'], [destinationAddress, message]);
            executable = await deployContract(wallet, 'TestInterchainExecutable', [service.address]);
        });

        it('Should revert on executeWithInterchainToken when not called by the service', async () => {
            await expectRevert(
                (gasOptions) =>
                    executable.executeWithInterchainToken(
                        commandId,
                        sourceChain,
                        sourceAddress,
                        data,
                        tokenId,
                        token.address,
                        amount,
                        gasOptions,
                    ),
                executable,
                'NotService',
                [wallet.address],
            );
        });

        it('Should revert on expressExecuteWithInterchainToken when not called by the service', async () => {
            await expectRevert(
                (gasOptions) =>
                    executable.expressExecuteWithInterchainToken(
                        commandId,
                        sourceChain,
                        sourceAddress,
                        data,
                        tokenId,
                        token.address,
                        amount,
                        gasOptions,
                    ),
                executable,
                'NotService',
                [wallet.address],
            );
        });

        it('Should revert on express execute when service is paused', async () => {
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destinationAddress, amount, '0x'],
            );

            await service.setPauseStatus(true).then((tx) => tx.wait);

            await expectRevert(
                (gasOptions) => service.expressExecute(commandId, sourceChain, sourceAddress, payload, gasOptions),
                service,
                'Pause',
            );

            await service.setPauseStatus(false).then((tx) => tx.wait);
        });
    });

    describe('Express Receive Remote Token', () => {
        let sourceAddress;
        const amount = 1234;
        const destAddress = new Wallet(getRandomBytes32()).address;
        let token, tokenManager, tokenId;

        before(async () => {
            sourceAddress = service.address;
            [token, tokenManager, tokenId] = await deployFunctions.lockUnlock(service, 'Test Token Lock Unlock', 'TT', 12, 4 * amount);
        });

        it('Should revert if command is already executed by gateway', async () => {
            await token.transfer(tokenManager.address, amount).then((tx) => tx.wait);
            await token.approve(service.address, amount).then((tx) => tx.wait);

            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destAddress, amount, '0x'],
            );

            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expectRevert(
                (gasOptions) => service.expressExecute(commandId, sourceChain, sourceAddress, payload, gasOptions),
                service,
                'AlreadyExecuted',
            );
        });

        it('Should revert with invalid messageType', async () => {
            await token.transfer(tokenManager.address, amount).then((tx) => tx.wait);
            await token.approve(service.address, amount).then((tx) => tx.wait);

            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'uint256'],
                [MESSAGE_TYPE_DEPLOY_TOKEN_MANAGER, tokenId, destAddress, amount],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expectRevert(
                (gasOptions) => service.expressExecute(commandId, sourceChain, sourceAddress, payload, gasOptions),
                service,
                'InvalidExpressMessageType',
                [MESSAGE_TYPE_DEPLOY_TOKEN_MANAGER],
            );
        });

        it('Should be able to receive lock_unlock token', async () => {
            await token.transfer(tokenManager.address, amount).then((tx) => tx.wait);
            await token.approve(service.address, amount).then((tx) => tx.wait);

            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destAddress, amount, '0x'],
            );

            const commandId = getRandomBytes32();
            await service.expressExecute(commandId, sourceChain, sourceAddress, payload).then((tx) => tx.wait);
            await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload, getRandomBytes32(), 0, commandId);

            await expect(service.execute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(token, 'Transfer')
                .withArgs(tokenManager.address, wallet.address, amount)
                .and.to.emit(service, 'ExpressExecutionFulfilled')
                .withArgs(commandId, sourceChain, sourceAddress, keccak256(payload), wallet.address);
        });

        it('Should be able to receive native_interchain token', async () => {
            const salt = getRandomBytes32();
            await (await service.deployInterchainToken(salt, '', 'Test Token Mint Burn', 'TT', 12, wallet.address, 0)).wait();
            const tokenId = await service.interchainTokenId(wallet.address, salt);
            const token = await getContractAt('InterchainToken', await service.interchainTokenAddress(tokenId), wallet);

            await (await token.mint(wallet.address, amount)).wait();
            await (await token.approve(service.address, amount)).wait();

            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destAddress, amount, '0x'],
            );
            const commandId = getRandomBytes32();

            await (await service.expressExecute(commandId, sourceChain, sourceAddress, payload)).wait();
            expect(await service.getExpressExecutor(commandId, sourceChain, sourceAddress, keccak256(payload))).to.equal(wallet.address);

            await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload, getRandomBytes32(), 0, commandId);

            await expect(service.execute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(token, 'Transfer')
                .withArgs(AddressZero, wallet.address, amount)
                .and.to.emit(service, 'ExpressExecutionFulfilled')
                .withArgs(commandId, sourceChain, sourceAddress, keccak256(payload), wallet.address);
        });

        it('Should be able to receive mint_burn token', async () => {
            const [token, , tokenId] = await deployFunctions.mintBurn(service, 'Test Token Mint Burn', 'TT', 12, amount);

            await token.approve(service.address, amount).then((tx) => tx.wait);

            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destAddress, amount, '0x'],
            );
            const commandId = getRandomBytes32();

            await service.expressExecute(commandId, sourceChain, sourceAddress, payload).then((tx) => tx.wait);
            expect(await service.getExpressExecutor(commandId, sourceChain, sourceAddress, keccak256(payload))).to.equal(wallet.address);

            await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload, getRandomBytes32(), 0, commandId);

            await expect(service.execute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(token, 'Transfer')
                .withArgs(AddressZero, wallet.address, amount)
                .and.to.emit(service, 'ExpressExecutionFulfilled')
                .withArgs(commandId, sourceChain, sourceAddress, keccak256(payload), wallet.address);
        });

        it('Should be able to receive mint_burn_from token', async () => {
            const [token, , tokenId] = await deployFunctions.mintBurnFrom(service, 'Test Token Mint Burn From', 'TT', 12, amount);

            await token.approve(service.address, amount).then((tx) => tx.wait);

            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destAddress, amount, '0x'],
            );
            const commandId = getRandomBytes32();

            await service.expressExecute(commandId, sourceChain, sourceAddress, payload).then((tx) => tx.wait);
            expect(await service.getExpressExecutor(commandId, sourceChain, sourceAddress, keccak256(payload))).to.equal(wallet.address);

            await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload, getRandomBytes32(), 0, commandId);

            await expect(service.execute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(token, 'Transfer')
                .withArgs(AddressZero, wallet.address, amount)
                .and.to.emit(service, 'ExpressExecutionFulfilled')
                .withArgs(commandId, sourceChain, sourceAddress, keccak256(payload), wallet.address);
        });

        it('Should be able to receive lock_unlock_with_fee token', async () => {
            const [token, tokenManager, tokenId] = await deployFunctions.lockUnlockFee(
                service,
                'Test Token Lock Unlock',
                'TT',
                12,
                2 * amount + 10,
            );
            await token.transfer(tokenManager.address, amount + 10).then((tx) => tx.wait);
            await token.approve(service.address, amount).then((tx) => tx.wait);

            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destAddress, amount, '0x'],
            );
            const commandId = getRandomBytes32();

            await service.expressExecute(commandId, sourceChain, sourceAddress, payload).then((tx) => tx.wait);
            expect(await service.getExpressExecutor(commandId, sourceChain, sourceAddress, keccak256(payload))).to.equal(wallet.address);

            await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload, getRandomBytes32(), 0, commandId);

            await expect(service.execute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(token, 'Transfer')
                .withArgs(tokenManager.address, wallet.address, amount)
                .and.to.emit(service, 'ExpressExecutionFulfilled')
                .withArgs(commandId, sourceChain, sourceAddress, keccak256(payload), wallet.address);
        });

        it('Should be able to receive lock_unlock_with_fee token with normal ERC20 token', async () => {
            const [token, tokenManager, tokenId] = await deployFunctions.lockUnlockFee(
                service,
                'Test Token Lock Unlock',
                'TT',
                12,
                2 * amount,
                false,
                'free',
            );
            await token.transfer(tokenManager.address, amount).then((tx) => tx.wait);
            await token.approve(service.address, amount).then((tx) => tx.wait);

            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), destAddress, amount, '0x'],
            );
            const commandId = getRandomBytes32();

            await service.expressExecute(commandId, sourceChain, sourceAddress, payload).then((tx) => tx.wait);
            expect(await service.getExpressExecutor(commandId, sourceChain, sourceAddress, keccak256(payload))).to.equal(wallet.address);

            await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload, getRandomBytes32(), 0, commandId);

            await expect(service.execute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(token, 'Transfer')
                .withArgs(tokenManager.address, wallet.address, amount)
                .and.to.emit(service, 'ExpressExecutionFulfilled')
                .withArgs(commandId, sourceChain, sourceAddress, keccak256(payload), wallet.address);
        });
    });

    describe('Express Receive Remote Token with Data', () => {
        let sourceAddress;
        const sourceAddressForService = '0x1234';
        const amount = 1234;
        let destAddress;
        let executable;

        before(async () => {
            sourceAddress = service.address;
            executable = await deployContract(wallet, 'TestInterchainExecutable', [service.address]);
            destAddress = executable.address;
        });

        it('Should be able to receive lock_unlock token', async () => {
            const [token, tokenManager, tokenId] = await deployFunctions.lockUnlock(
                service,
                'Test Token Lock Unlock',
                'TT',
                12,
                amount * 2,
            );
            await token.transfer(tokenManager.address, amount).then((tx) => tx.wait);
            await token.approve(service.address, amount).then((tx) => tx.wait);

            const msg = 'lock/unlock';
            const data = defaultAbiCoder.encode(['address', 'string'], [wallet.address, msg]);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddressForService, destAddress, amount, data],
            );

            const commandId = getRandomBytes32();
            await service.expressExecute(commandId, sourceChain, sourceAddress, payload).then((tx) => tx.wait);
            await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload, getRandomBytes32(), 0, commandId);

            const tx = service.execute(commandId, sourceChain, sourceAddress, payload);
            await expect(tx)
                .to.emit(token, 'Transfer')
                .withArgs(tokenManager.address, wallet.address, amount)
                .and.to.emit(service, 'ExpressExecutionFulfilled')
                .withArgs(commandId, sourceChain, sourceAddress, keccak256(payload), wallet.address);

            expect(await executable.lastMessage()).to.equal(msg);
        });

        it('Should be able to receive native_interchain token', async () => {
            const salt = getRandomBytes32();
            await (await service.deployInterchainToken(salt, '', 'Test Token Mint Burn', 'TT', 12, wallet.address, 0)).wait();
            const tokenId = await service.interchainTokenId(wallet.address, salt);
            const token = await getContractAt('InterchainToken', await service.interchainTokenAddress(tokenId), wallet);

            await (await token.mint(wallet.address, amount)).wait();
            await (await token.approve(service.address, amount)).wait();

            const msg = 'mint/burn';
            const data = defaultAbiCoder.encode(['address', 'string'], [wallet.address, msg]);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddressForService, destAddress, amount, data],
            );

            const commandId = getRandomBytes32();
            await (await service.expressExecute(commandId, sourceChain, sourceAddress, payload)).wait();
            await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload, getRandomBytes32(), 0, commandId);

            await expect(service.execute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(token, 'Transfer')
                .withArgs(AddressZero, wallet.address, amount)
                .and.to.emit(service, 'ExpressExecutionFulfilled')
                .withArgs(commandId, sourceChain, sourceAddress, keccak256(payload), wallet.address);

            expect(await executable.lastMessage()).to.equal(msg);
        });

        it('Should be able to receive mint_burn token', async () => {
            const [token, , tokenId] = await deployFunctions.mintBurn(service, 'Test Token Mint Burn', 'TT', 12, amount);
            await token.approve(service.address, amount).then((tx) => tx.wait);

            const msg = 'mint/burn';
            const data = defaultAbiCoder.encode(['address', 'string'], [wallet.address, msg]);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddressForService, destAddress, amount, data],
            );

            const commandId = getRandomBytes32();
            await service.expressExecute(commandId, sourceChain, sourceAddress, payload).then((tx) => tx.wait);
            await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload, getRandomBytes32(), 0, commandId);

            await expect(service.execute(commandId, sourceChain, sourceAddress, payload))
                .to.emit(token, 'Transfer')
                .withArgs(AddressZero, wallet.address, amount)
                .and.to.emit(service, 'ExpressExecutionFulfilled')
                .withArgs(commandId, sourceChain, sourceAddress, keccak256(payload), wallet.address);

            expect(await executable.lastMessage()).to.equal(msg);
        });

        it('Should be able to receive lock_unlock_with_fee token', async () => {
            const [token, tokenManager, tokenId] = await deployFunctions.lockUnlockFee(
                service,
                'Test Token Lock Unlock',
                'TT',
                12,
                amount * 2 + 10,
            );
            await token.transfer(tokenManager.address, amount + 10).then((tx) => tx.wait);
            await token.approve(service.address, amount).then((tx) => tx.wait);

            const msg = 'lock/unlock';
            const data = defaultAbiCoder.encode(['address', 'string'], [wallet.address, msg]);
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, sourceAddressForService, destAddress, amount, data],
            );
            const commandId = await approveContractCall(gateway, sourceChain, sourceAddress, service.address, payload);

            await expect(service.expressExecute(commandId, sourceChain, sourceAddress, payload)).to.be.reverted;
        });
    });

    describe('Flow Limits', () => {
        const destinationAddress = '0x1234';
        let tokenManager, tokenId;
        const sendAmount = 1234;
        const flowLimit = (sendAmount * 3) / 2;
        const mintAmount = MaxUint256;

        before(async () => {
            [, tokenManager, tokenId] = await deployFunctions.mintBurn(service, 'Test Token Lock Unlock', 'TT', 12, mintAmount);
            await tokenManager.setFlowLimit(flowLimit).then((tx) => tx.wait);
        });

        it('Should be able to send token only if it does not trigger the mint limit', async () => {
            await service.interchainTransfer(tokenId, destinationChain, destinationAddress, sendAmount, '0x', 0).then((tx) => tx.wait);

            const errorSignatureHash = id('FlowLimitExceeded(uint256,uint256,address)');
            const selector = errorSignatureHash.substring(0, 10);
            const errorData = defaultAbiCoder.encode(['uint256', 'uint256', 'address'], [flowLimit, 2 * sendAmount, tokenManager.address]);

            await expectRevert(
                (gasOptions) => service.interchainTransfer(tokenId, destinationChain, destinationAddress, sendAmount, '0x', 0, gasOptions),
                service,
                'TakeTokenFailed',
                [selector + errorData.substring(2)],
            );
        });

        it('Should be able to receive token only if it does not trigger the mint limit', async () => {
            const tokenFlowLimit = await service.flowLimit(tokenId);
            expect(tokenFlowLimit).to.eq(flowLimit);

            let flowIn = await service.flowInAmount(tokenId);
            let flowOut = await service.flowOutAmount(tokenId);

            expect(flowIn).to.eq(0);
            expect(flowOut).to.eq(sendAmount);

            async function receiveToken(amount) {
                const payload = defaultAbiCoder.encode(
                    ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                    [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), wallet.address, amount, '0x'],
                );
                const commandId = await approveContractCall(gateway, destinationChain, service.address, service.address, payload);

                return service.execute(commandId, destinationChain, service.address, payload);
            }

            await receiveToken(sendAmount).then((tx) => tx.wait);

            flowIn = await service.flowInAmount(tokenId);
            flowOut = await service.flowOutAmount(tokenId);

            expect(flowIn).to.eq(sendAmount);
            expect(flowOut).to.eq(sendAmount);

            const errorSignatureHash = id('FlowLimitExceeded(uint256,uint256,address)');
            const selector = errorSignatureHash.substring(0, 10);
            const errorData = defaultAbiCoder.encode(
                ['uint256', 'uint256', 'address'],
                [(5 * sendAmount) / 2, 3 * sendAmount, tokenManager.address],
            );

            await expectRevert((gasOptions) => receiveToken(2 * sendAmount, gasOptions), service, 'GiveTokenFailed', [
                selector + errorData.substring(2),
            ]);
        });

        it('Should revert if the flow limit overflows', async () => {
            const tokenFlowLimit = await service.flowLimit(tokenId);
            expect(tokenFlowLimit).to.eq(flowLimit);

            const flowIn = await service.flowInAmount(tokenId);
            const flowOut = await service.flowOutAmount(tokenId);

            expect(flowIn).to.eq(sendAmount);
            expect(flowOut).to.eq(sendAmount);

            const newSendAmount = 1;
            const newFlowLimit = MaxUint256;

            await tokenManager.setFlowLimit(newFlowLimit).then((tx) => tx.wait);

            async function receiveToken(amount) {
                const payload = defaultAbiCoder.encode(
                    ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                    [MESSAGE_TYPE_INTERCHAIN_TRANSFER, tokenId, hexlify(wallet.address), wallet.address, amount, '0x'],
                );
                const commandId = await approveContractCall(gateway, destinationChain, service.address, service.address, payload);

                return service.execute(commandId, destinationChain, service.address, payload);
            }

            const errorSignatureHash = id('FlowLimitOverflow(uint256,uint256,address)');
            const selector = errorSignatureHash.substring(0, 10);
            const errorData = defaultAbiCoder.encode(['uint256', 'uint256', 'address'], [newFlowLimit, flowIn, tokenManager.address]);

            await expectRevert((gasOptions) => receiveToken(newSendAmount, gasOptions), service, 'GiveTokenFailed', [
                selector + errorData.substring(2),
            ]);
        });

        it('Should revert if the flow addition overflows', async () => {
            const tokenFlowLimit = await service.flowLimit(tokenId);
            expect(tokenFlowLimit).to.eq(MaxUint256);

            const flowIn = await service.flowInAmount(tokenId);
            const flowOut = await service.flowOutAmount(tokenId);

            expect(flowIn).to.eq(sendAmount);
            expect(flowOut).to.eq(sendAmount);

            const newSendAmount = MaxUint256;

            const errorSignatureHash = id('FlowAdditionOverflow(uint256,uint256,address)');
            const selector = errorSignatureHash.substring(0, 10);
            const errorData = defaultAbiCoder.encode(['uint256', 'uint256', 'address'], [newSendAmount, flowOut, tokenManager.address]);

            await expectRevert(
                (gasOptions) =>
                    service.interchainTransfer(tokenId, destinationChain, destinationAddress, newSendAmount, '0x', 0, gasOptions),
                service,
                'TakeTokenFailed',
                [selector + errorData.substring(2)],
            );
        });

        it('Should be able to set flow limits for each token manager', async () => {
            const tokenIds = [];
            const tokenManagers = [];

            for (const type of ['lockUnlock', 'mintBurn', 'lockUnlockFee']) {
                const [, tokenManager, tokenId] = await deployFunctions[type](service, `Test Token ${type}`, 'TT', 12, mintAmount);
                tokenIds.push(tokenId);
                tokenManagers.push(tokenManager);
            }

            const flowLimits = new Array(tokenManagers.length).fill(flowLimit);

            await expectRevert(
                (gasOptions) => service.connect(otherWallet).setFlowLimits(tokenIds, flowLimits, gasOptions),
                service,
                'MissingRole',
                [otherWallet.address, OPERATOR_ROLE],
            );

            await expect(service.setFlowLimits(tokenIds, flowLimits))
                .to.emit(tokenManagers[0], 'FlowLimitSet')
                .withArgs(tokenIds[0], service.address, flowLimit)
                .to.emit(tokenManagers[1], 'FlowLimitSet')
                .withArgs(tokenIds[1], service.address, flowLimit)
                .to.emit(tokenManagers[2], 'FlowLimitSet')
                .withArgs(tokenIds[2], service.address, flowLimit);

            flowLimits.pop();

            await expectRevert((gasOptions) => service.setFlowLimits(tokenIds, flowLimits, gasOptions), service, 'LengthMismatch');
        });
    });

    describe('Flow Limiters', () => {
        let tokenManager;
        const sendAmount = 1234;
        const flowLimit = (sendAmount * 3) / 2;
        const mintAmount = flowLimit * 3;

        before(async () => {
            [, tokenManager] = await deployFunctions.mintBurn(service, 'Test Token Lock Unlock', 'TT', 12, mintAmount);
        });

        it('Should have only the owner be a flow limiter', async () => {
            expect(await tokenManager.hasRole(wallet.address, FLOW_LIMITER_ROLE)).to.equal(true);
            expect(await tokenManager.hasRole(otherWallet.address, FLOW_LIMITER_ROLE)).to.equal(false);
        });

        it('Should be able to add a flow limiter', async () => {
            await expect(tokenManager.addFlowLimiter(otherWallet.address))
                .to.emit(tokenManager, 'RolesAdded')
                .withArgs(otherWallet.address, 1 << FLOW_LIMITER_ROLE);

            expect(await tokenManager.hasRole(wallet.address, FLOW_LIMITER_ROLE)).to.equal(true);
            expect(await tokenManager.hasRole(otherWallet.address, FLOW_LIMITER_ROLE)).to.equal(true);
        });

        it('Should be able to remove a flow limiter', async () => {
            await expect(tokenManager.removeFlowLimiter(wallet.address))
                .to.emit(tokenManager, 'RolesRemoved')
                .withArgs(wallet.address, 1 << FLOW_LIMITER_ROLE);

            expect(await tokenManager.hasRole(wallet.address, FLOW_LIMITER_ROLE)).to.equal(false);
            expect(await tokenManager.hasRole(otherWallet.address, FLOW_LIMITER_ROLE)).to.equal(true);
        });

        it('Should be able to transfer a flow limiter', async () => {
            await expect(tokenManager.transferFlowLimiter(otherWallet.address, wallet.address))
                .to.emit(tokenManager, 'RolesAdded')
                .withArgs(wallet.address, 1 << FLOW_LIMITER_ROLE)
                .to.emit(tokenManager, 'RolesRemoved')
                .withArgs(otherWallet.address, 1 << FLOW_LIMITER_ROLE);

            expect(await tokenManager.hasRole(wallet.address, FLOW_LIMITER_ROLE)).to.equal(true);
            expect(await tokenManager.hasRole(otherWallet.address, FLOW_LIMITER_ROLE)).to.equal(false);

            await expectRevert(
                (gasOptions) => tokenManager.transferFlowLimiter(otherWallet.address, wallet.address, gasOptions),
                tokenManager,
                'MissingAllRoles',
                [otherWallet.address, 1 << FLOW_LIMITER_ROLE],
            );
        });

        it('Should revert if trying to add a flow limiter as not the operator', async () => {
            await expectRevert(
                (gasOptions) => tokenManager.connect(otherWallet).addFlowLimiter(otherWallet.address, gasOptions),
                tokenManager,
                'MissingRole',
                [otherWallet.address, OPERATOR_ROLE],
            );
        });

        it('Should revert if trying to add a flow limiter as not the operator', async () => {
            await expectRevert(
                (gasOptions) => tokenManager.connect(otherWallet).removeFlowLimiter(wallet.address, gasOptions),
                tokenManager,
                'MissingRole',
                [otherWallet.address, OPERATOR_ROLE],
            );
        });

        it('Should be able to transfer a flow limiter and the operator in one call', async () => {
            const tx1Data = (await tokenManager.populateTransaction.transferFlowLimiter(wallet.address, otherWallet.address)).data;
            const tx2Data = (await tokenManager.populateTransaction.transferOperatorship(otherWallet.address)).data;
            await expect(tokenManager.multicall([tx1Data, tx2Data]))
                .to.emit(tokenManager, 'RolesAdded')
                .withArgs(otherWallet.address, 1 << FLOW_LIMITER_ROLE)
                .to.emit(tokenManager, 'RolesRemoved')
                .withArgs(wallet.address, 1 << FLOW_LIMITER_ROLE)
                .to.emit(tokenManager, 'RolesAdded')
                .withArgs(otherWallet.address, 1 << OPERATOR_ROLE)
                .to.emit(tokenManager, 'RolesRemoved')
                .withArgs(wallet.address, 1 << OPERATOR_ROLE);

            expect(await tokenManager.hasRole(wallet.address, FLOW_LIMITER_ROLE)).to.equal(false);
            expect(await tokenManager.hasRole(otherWallet.address, FLOW_LIMITER_ROLE)).to.equal(true);
            expect(await tokenManager.hasRole(wallet.address, OPERATOR_ROLE)).to.equal(false);
            expect(await tokenManager.hasRole(otherWallet.address, OPERATOR_ROLE)).to.equal(true);
        });
    });

    describe('Call contract value', () => {
        const trustedAddress = 'Trusted address';
        const amount = 100;

        it('Should revert on contractCallValue if not called by remote service', async () => {
            const payload = '0x';

            await expectRevert(
                (gasOptions) => service.contractCallValue(sourceChain, trustedAddress, payload, gasOptions),
                service,
                'NotRemoteService',
            );
        });

        it('Should revert on contractCallValue if service is paused', async () => {
            const payload = '0x';

            await service.setTrustedAddress(sourceChain, trustedAddress).then((tx) => tx.wait);

            await service.setPauseStatus(true).then((tx) => tx.wait);

            await expectRevert(
                (gasOptions) => service.contractCallValue(sourceChain, trustedAddress, payload, gasOptions),
                service,
                'Pause',
            );

            await service.setPauseStatus(false).then((tx) => tx.wait);
        });

        it('Should revert on invalid express message type', async () => {
            const message = 10;
            const tokenId = HashZero;
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [message, tokenId, '0x', '0x', amount, '0x'],
            );

            await expectRevert(
                (gasOptions) => service.contractCallValue(sourceChain, trustedAddress, payload, gasOptions),
                service,
                'InvalidExpressMessageType',
                [message],
            );
        });

        it('Should return correct token address and amount', async () => {
            const mintAmount = 1234;
            const [token, , tokenId] = await deployFunctions.lockUnlock(service, 'Test Token Lock Unlock', 'TT', 12, mintAmount);
            const message = 0;
            const payload = defaultAbiCoder.encode(
                ['uint256', 'bytes32', 'bytes', 'bytes', 'uint256', 'bytes'],
                [message, tokenId, '0x', '0x', amount, '0x'],
            );

            const [tokenAddress, returnedAmount] = await service.contractCallValue(sourceChain, trustedAddress, payload);

            expect(tokenAddress).to.eq(token.address);
            expect(returnedAmount).to.eq(amount);
        });
    });

    describe('Bytecode checks [ @skip-on-coverage ]', () => {
        it('Should preserve the same proxy bytecode for each EVM', async () => {
            const proxyFactory = await ethers.getContractFactory('InterchainProxy', wallet);
            const proxyBytecode = proxyFactory.bytecode;
            const proxyBytecodeHash = keccak256(proxyBytecode);

            const expected = {
                london: '0x57e9041ac230850afa53b1373118c6e6649eed78a7731296b62fc8455d49b4ef',
            }[getEVMVersion()];

            expect(proxyBytecodeHash).to.be.equal(expected);
        });
    });
});
