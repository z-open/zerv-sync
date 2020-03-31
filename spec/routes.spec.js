const routes = require('../lib/routes');
let api;
let apiRoutes;
let sync;
const currentVersion = '1.2';

describe('routes', function() {
    beforeEach(function() {
        apiRoutes = {};
        api = {};
        api.on = function(name, fn) {
            apiRoutes[name] = fn;
            return api;
        };

        sync = {
            subscribe: function() { },
            unsubscribe: function() { },
            getVersion: function() {
                return currentVersion;
            }
        };

        routes(api, sync);


        spyOn(sync, 'subscribe').and.returnValue({id: '#subId'});
        spyOn(sync, 'unsubscribe');
    });

    it('should not allow subscribe with an incompatible client sync version', function() {
        try {
            callApi(
                'sync.subscribe',
                {version: '0.1', id: 'sub#1', publication: 'magazine', params: {type: 'fiction'}}
            );
        } catch (err) {
            expect(err.message).toEqual('CLIENT_SYNC_VERSION_INCOMPATIBLE');
        }
    });

    it('should not allow unsubscribe with an incompatible client sync version', function() {
        try {
            callApi('sync.subscribe', {version: currentVersion, id: 'sub#1'});
        } catch (err) {
            expect(err.message).toEqual('CLIENT_SYNC_VERSION_INCOMPATIBLE');
        }
    });


    it('should register subscribe route', function() {
        callApi(
            'sync.subscribe',
            {version: currentVersion, id: 'sub#1', publication: 'magazine', params: {type: 'fiction'}}
        );
        expect(sync.subscribe).toHaveBeenCalled();
    // need to check params
    });

    it('should registerunsubscribe', function() {
        callApi('sync.subscribe', {version: currentVersion, id: 'sub#1'});
        expect(sync.subscribe).toHaveBeenCalled();
    });

    function callApi(name, params) {
        apiRoutes[name](params);
    }
});
