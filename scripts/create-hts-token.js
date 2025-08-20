const { AccountId, TokenCreateTransaction, TokenSupplyType, TokenType } = require('@hashgraph/sdk');

function evmAddressToAccountId(evmAddress) {
    return AccountId.fromEvmAddress(evmAddress);
}

async function createHtsToken(hederaClient, operatorPk, name, symbol, decimals = 8, intialSupply = 0) {
    const tokenCreateTx = new TokenCreateTransaction()
        .setTokenName(name)
        .setTokenSymbol(symbol)
        .setTokenType(TokenType.FungibleCommon)
        .setDecimals(decimals)
        .setInitialSupply(intialSupply)
        .setTreasuryAccountId(hederaClient._operator.accountId)
        .setSupplyType(TokenSupplyType.Infinite)
        .setSupplyKey(operatorPk)
        .freezeWith(hederaClient);

    const tokenCreateSign = await tokenCreateTx.sign(operatorPk);
    const tokenCreateSubmit = await tokenCreateSign.execute(hederaClient);
    const tokenCreateRx = await tokenCreateSubmit.getReceipt(hederaClient);
    const tokenId = tokenCreateRx.tokenId;
    const tokenAddress = `0x${tokenId.toSolidityAddress().toLowerCase()}`;

    return [tokenAddress, tokenId];
}

/**
 * Creates an HTS token with specified keys that may make it unsupported by ITS
 * @param {Object} hederaClient - The Hedera client
 * @param {PrivateKey} operatorPk - The operator private key
 * @param {string} name - Token name
 * @param {string} symbol - Token symbol
 * @param {number} decimals - Token decimals
 * @param {number} initialSupply - Initial token supply
 * @param {Object} keys - Object specifying which keys to set: { kyc: boolean, freeze: boolean, wipe: boolean, pause: boolean }
 * @returns {Promise<[string, TokenId]>} Returns [tokenAddress, tokenId]
 */
async function createHtsTokenWithKeys(hederaClient, operatorPk, name, symbol, decimals = 8, initialSupply = 0, keys = {}) {
    const tokenCreateTx = new TokenCreateTransaction()
        .setTokenName(name)
        .setTokenSymbol(symbol)
        .setTokenType(TokenType.FungibleCommon)
        .setDecimals(decimals)
        .setInitialSupply(initialSupply)
        .setTreasuryAccountId(hederaClient._operator.accountId)
        .setSupplyType(TokenSupplyType.Infinite)
        .setSupplyKey(operatorPk);

    // Add keys that make the token unsupported by ITS
    if (keys.kyc) {
        tokenCreateTx.setKycKey(operatorPk);
    }

    if (keys.freeze) {
        tokenCreateTx.setFreezeKey(operatorPk);
    }

    if (keys.wipe) {
        tokenCreateTx.setWipeKey(operatorPk);
    }

    if (keys.pause) {
        tokenCreateTx.setPauseKey(operatorPk);
    }

    tokenCreateTx.freezeWith(hederaClient);

    const tokenCreateSign = await tokenCreateTx.sign(operatorPk);
    const tokenCreateSubmit = await tokenCreateSign.execute(hederaClient);
    const tokenCreateRx = await tokenCreateSubmit.getReceipt(hederaClient);
    const tokenId = tokenCreateRx.tokenId;
    const tokenAddress = `0x${tokenId.toSolidityAddress().toLowerCase()}`;

    return [tokenAddress, tokenId];
}

module.exports = {
    evmAddressToAccountId,
    createHtsToken,
    createHtsTokenWithKeys,
};
