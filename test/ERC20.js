'use strict';

const chai = require('chai');
const { ethers } = require('hardhat');
const {
    Contract,
    constants: { MaxUint256, AddressZero },
} = ethers;
const { expect } = chai;
const { getRandomBytes32, expectRevert } = require('./utils');
const { deployContract } = require('../scripts/deploy');

const StandardizedToken = require('../artifacts/contracts/token-implementations/StandardizedToken.sol/StandardizedToken.json');

describe('ERC20', () => {
    let standardizedToken, standardizedTokenDeployer;

    const name = 'tokenName';
    const symbol = 'tokenSymbol';
    const decimals = 18;
    const mintAmount = 123;

    let token;

    let owner, user;

    before(async () => {
        const wallets = await ethers.getSigners();
        owner = wallets[0];
        user = wallets[1];

        standardizedToken = await deployContract(owner, 'StandardizedToken');
        standardizedTokenDeployer = await deployContract(owner, 'StandardizedTokenDeployer', [standardizedToken.address]);

        const salt = getRandomBytes32();

        const tokenAddress = await standardizedTokenDeployer.deployedAddress(salt);

        token = new Contract(tokenAddress, StandardizedToken.abi, owner);

        await standardizedTokenDeployer
            .deployStandardizedToken(salt, owner.address, owner.address, name, symbol, decimals, mintAmount, owner.address)
            .then((tx) => tx.wait());
    });

    it('should increase and decrease allowance', async () => {
        const initialAllowance = await token.allowance(user.address, owner.address);
        expect(initialAllowance).to.eq(0);

        await expect(token.connect(user).increaseAllowance(owner.address, MaxUint256))
            .to.emit(token, 'Approval')
            .withArgs(user.address, owner.address, MaxUint256);

        const increasedAllowance = await token.allowance(user.address, owner.address);
        expect(increasedAllowance).to.eq(MaxUint256);

        await expect(token.connect(user).decreaseAllowance(owner.address, MaxUint256))
            .to.emit(token, 'Approval')
            .withArgs(user.address, owner.address, 0);

        const finalAllowance = await token.allowance(user.address, owner.address);
        expect(finalAllowance).to.eq(0);
    });

    it('should revert on approve with invalid owner or sender', async () => {
        await expectRevert(
            (gasOptions) => token.connect(owner).transferFrom(AddressZero, owner.address, 0, gasOptions),
            token,
            'InvalidAccount',
        );

        await expectRevert(
            (gasOptions) => token.connect(user).increaseAllowance(AddressZero, MaxUint256, gasOptions),
            token,
            'InvalidAccount',
        );
    });

    it('should revert on transfer to invalid address', async () => {
        const initialAllowance = await token.allowance(user.address, owner.address);
        expect(initialAllowance).to.eq(0);

        await expect(token.connect(user).increaseAllowance(owner.address, MaxUint256))
            .to.emit(token, 'Approval')
            .withArgs(user.address, owner.address, MaxUint256);

        const increasedAllowance = await token.allowance(user.address, owner.address);
        expect(increasedAllowance).to.eq(MaxUint256);

        const amount = 100;

        await expectRevert(
            (gasOptions) => token.connect(owner).transferFrom(user.address, AddressZero, amount, gasOptions),
            token,
            'InvalidAccount',
        );
    });

    it('should revert mint or burn to invalid address', async () => {
        const amount = 100;
        await expectRevert((gasOptions) => token.mint(AddressZero, amount, gasOptions), token, 'InvalidAccount');
        await expectRevert((gasOptions) => token.burn(AddressZero, amount, gasOptions), token, 'InvalidAccount');
    });
});