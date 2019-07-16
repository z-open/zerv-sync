'use strict';
const _ = require('lodash');

/**
 * 
 * Create  a Zerror that can wrap a previous error.
 * 
 * The error would only return the provided errId in its message to not expose the internals when errors are sent back to third party client (front en) but
 * However the stack shall show the origin of the error for easy Node debugging. So it is practical for use with promises
 * reject (new Zerror('PROCESS_FAILED',err))
 * 
 * It promotes:
 * - the user of zError custom error to group the error under a type, ex 'CRM_ERROR'
 * - defining clear error via errId, ex: 'PROCESS_DENY', 'DUPLICATE_VALUE' instead of long error msg
 *
 * Error Description details string or object can still be provided
 * 
 * 
 * 
 * Example of construction
 * 
 * err = new Zerror('FATAL_ERROR')
 * the error message would be 'FATAL_ERROR', the err.code would be ZIMIT_ERROR
 * 
 * ex: originError = new Error('Db Issue')
 * err = new Zerror(originError)
 * err.code would equal ZIMIT_ERROR
 * err.message would equal 'INTERNAL_ERROR'
 * err.stack would have the err stack plus the originError stack where you would notice the 'db issue'
 * 
 * 
 * ex: zerror loginError is a custom error with errId = LOGIN_ERR, description ='User credentials incorrect
 * err = new Zerror(loginError)
 * err.code would equal ZIMIT_ERROR
 * err.message would equal LOGIN_ERROR
 * err.stack would have the crmError stack plus the loginError stack.
 * err.description would have 'User crednetials incorret'
 * 
 * Ex:
 * err = new Zerror('ACCESS_DENY',loginError)
 * err.code would equal ZIMIT_ERROR
 * err.message would equal 'ACCESS_DENY'
 * err.stack would have the crmError stack plus the loginError stack.
 * 
 * 
 */
module.exports = Zerror;

function Zerror(errId, description, previousError) {
    /* eslint-disable prefer-rest-params */
    const args = _.remove(arguments, _.isNill);
    /* eslint-enable prefer-rest-params */
    if (errId instanceof Error) {
        if (args.length !== 1) {
            throw new Zerror('Zerror object not properly defined');
        }
        if (errId instanceof Zerror) {
            // building a zError from another should not stack the stacktrace which would be of no value
            _.assign(this, errId);
            return;
        }
        previousError = errId;
        this.description = null;
        this.message = 'INTERNAL_ERROR';

    } else if (description instanceof Error) {
        if (args.length !== 2) {
            throw new Zerror('Zerror object not properly defined');
        }
        previousError = description;
        this.description = null;
        this.message = errId;

    } else {
        this.description = description;
        this.message = errId;
    }

    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
    if (this.description) {
        this.stack = this.description + '\n' +  this.stack;
    }
    if (previousError) {
        if (previousError.stack) {
            this.stack += '\n' + previousError.stack;
        }
        else {
            // previous Error should be error object as best practice...but if not
            this.stack += '\nError: ' + JSON.stringify(previousError);
        }
    }

    this.code = 'ZERV_ERROR';
};

require('util').inherits(module.exports, Error);
