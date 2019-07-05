const _ = require('lodash');
const syncHelper = require('../lib/sync.helper');

describe('Sync Helper', function () {


    it('get simple obj differences', function () {
        const originalObject = {
            name: 'Minolo',
            tracks: [
                {
                    id: 1,
                    display: 'Requirement'
                },
                {
                    id: 2,
                    display: 'Implementation'
                }
            ],
            revision: 1
        };


        const updatedObject = {
            name: 'Maxolo',
            tracks: [
                {
                    id: 1,
                    display: 'Requirement Phase'
                }
            ],
            revision: 1
        };


        const change = syncHelper.differenceBetween(updatedObject, originalObject);

        console.info(JSON.stringify(change, null, 2));
        expect(change).toEqual(
            {
                "name": "Maxolo",
                "tracks": [
                    {
                        "id": 1,
                        "display": "Requirement Phase"
                    },
                    {
                        "id": 2,
                        "$removed": true
                    }
                ]
            }
        );

        const obj = _.clone(originalObject);
        const syncedObj = syncHelper.mergeChanges(obj, change);
        expect(syncedObj).toEqual(updatedObject);
    });

    it('update complex obj', function () {
        const originalObject = {
            name: 'Minolo',
            tracks: [
                {
                    id: 1,
                    display: 'Requirement',
                    resources: [
                        { id: 1, name: 'pedro' },
                        { id: 2, name: 'pablo' },
                        { id: 3, name: 'john' }
                    ]
                },
                {
                    id: 2,
                    display: 'Implementation',
                    resources: [
                        { id: 1, name: 'thomas' }
                    ]
                }
            ],
            revision: 1
        };


        const updatedObject = {
            name: 'Minolo',
            tracks: [
                {
                    id: 1,
                    display: 'Requirement',
                    resources: [
                        // peter is updated
                        { id: 1, name: 'peter' },
                        // pablo is removed
                        { id: 3, name: 'john' },
                        { id: 4, name: 'philip' },
                    ]
                },
                {
                    id: 2,
                    display: 'Implementation',
                    // all resources removed
                    resources: []
                }
            ],
            revision: 1
        };


        const change = syncHelper.differenceBetween(updatedObject, originalObject);

        console.info(JSON.stringify(change, null, 2));
        expect(change).toEqual(
            {
                "tracks": [
                    {
                        "id": 1,
                        "resources": [
                            {
                                "id": 1,
                                "name": "peter"
                            },
                            {
                                "id": 4,
                                "name": "philip"
                            },
                            {
                                "id": 2,
                                "$removed": true
                            }
                        ]
                    },
                    {
                        "id": 2,
                        "resources": []
                    }
                ]
            }
        );
        const obj = _.clone(originalObject);
        const syncedObj = syncHelper.mergeChanges(obj, change);
        expect(syncedObj).toEqual(updatedObject);
    });
});
