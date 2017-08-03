
module.exports = {
    extends: [
        'eslint-config-google',
    ],
    "parserOptions": {
        "ecmaVersion": 6
    },
    rules: {
        'no-invalid-this': 0,
        'one-var': 0,
        'prefer-rest-params': 0,
        'max-len': 0,
        'require-jsdoc': 0,
        'valid-jsdoc': 0,
        'comma-dangle': 0,

        //node_modules/eslint/bin/eslint.js --fix 
        'no-var': 1
    }
}