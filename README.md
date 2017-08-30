# zerv-sync



### Scope

This node module handles the data synchronization on the server side over socket connection.


### pre-requisite

zerv-core middleware
First, set up your node server to use express with the zerv-core module.

zerv-ng-sync client
It requires the client to use the zerv-ng-sync bower package to establish the syncing process.


### Principle

Client subscribes to a publication defined on the backend.
When the subscription is established, the backend subscription will fetch data from the db and send them to the subscribers.

When data is updated in the backend, a notification must be implemented to emit the data/object change.
Publications react to those notifications. They will directly push the changes to their subscribers if determined to be related.

The objective is to decrease the number of accesses to the db:

- In most cases, the publication only needs to access the persistence layer at initialization anb just needs to be notified of changes as they occur.
- If the connection to the subscribers is lost for a short period of time, the publication caches potential changes. It gives enough time for the client to reconnect preventing db access.
- If connection is lost for a long time, the cache will be released. At its reconnection, client will get a new subscription that will fetch data from the db.

NOTE: 
The client MUST reconnect on the same node server to get what is the queue for an existing subscription...otherwise it will resubscribe on the new node server and fetch all data.
This might be taken in consideration when implementing a load balancing strategy.


### Basic implementation

Create a publication on the backend. the publication is set to listen to data changes
 ex:
  
     sync.publish('magazines.sync',function(tenantId,userId,params){
       return magazineService.fetchForUser(userId,params.type)
       },MAGAZINE_DATA);
     }
 
Note:

sync functionalities are also accessible from zerv. So sync and zerv are interchangeable.

ex:

     zerv.publish(....)

In the front end code, subscribe to this publication.
Currently only angular 1.5 and above have a zerv client library (use zerv-ng-sync).
In this example, it is a subscription to an array.
 ex:

    var sds = $sync.subscribe(
            'magazines',
            scope).setParameters({ type: 'fiction'});
    var mySyncList = sds.getData();


 On the backend, When your api update, create or remove data, notify the data changes. 
 The notified object should match the params provided in the subscription in order to the data to be pushed to the client.

 ex: 

     var zerv = require("zerv-core");
     function createMagazine(magazine) {
        magazine.revision = 0;
        return saveInDb(magazine).then(function (magazine) {
            zerv.notifyCreation('MAGAZINE_DATA', magazine);
            return magazine
        });
     }

     function updateMagazine(magazine) {
        magazine.revision++;
        return saveInDb(magazine).then(function (magazine) {
            zerv.notifyChanges('MAGAZINE_DATA', magazine);
        return magazine
        });
     }
 
     function removeMagazine(magazine) {
        magazine.revision++;
        return removeFromDb(magazine).then(function (rep) {
            zerv.notifyRemoval('MAGAZINE_DATA', magazine);
            return rep;
        });
     }

### Publication Notification options

    sync.publish(publication_name,fetchFn,dataNotification, options)

DataNotification is required.

So when an object is notified (notifyCreation, notifyDelete, notifyUpdate), the publication listening to this event will check if a subscription needs to receive the notified object.



#### DataNotification {String}
ex:  

     sync.publish('magazines.sync',function(tenantId,userId,params){
        return magazineService.fetchForUser(userId,params.type)
     },'MAGAZINE_DATA'}

Each notification to MAGAZINE_DATA, will be sent to the subscription if it matches ALL subscription params.

#### DataNotification {Object}
An object map of notification events can be defined.
For each event, a configuration can also be provided to format or filter the notification. 
Format and filter are optionals.

ex:  

     sync.publish('magazines.sync',function(tenantId,userId,params){
        return service.fetchMagazineAndArticleForUser(userId,params.type)
     },{
         'MAGAZINE_DATA: {},
         'SCIENCE_ARTICLE_DATE': {
             format: function(scienceArticle) {
                 return formatScienceArticleToMagazine(scienceArticle)
             },
             filter: function(scienceArticle,subscriptionParams) {
                 return subscriptionParams.type === scienceArticle.field
             }

         }
    }

In the example above, 

Each notification to MAGAZINE_DATA, will be sent to the subscription if it matches ALL subscription params.

The scienceArticle object will only be sent to all subscriptions which makes the filter filter return true. 
If it does, it will be formated to suit the type of object that are supposed to be received by the subscription.

Notice the fetch function (service.fetchMagazineAndArticleForUser) that pulls all the expected data at initialization.

### Publication options

sync.publish(publication_name,fetchFn,dataNotification, options)

Options is an optional object that might have the following key/value

#### always {boolean}
Push all records to the client for each notification. By default, only notified object might be pushed to the client.
This should only be use for publications that requires complex db joins and barely get notified of changes

ex:

     sync.publish('magazines.sync',function(tenantId,userId,params){
        return magazineService.fetchForUser(userId,params.type)
     },MAGAZINE_DATA,
     {
         always:true
     });
     }

when always is true, each time there is a notification on MAGAZINE_DATA, the fetch will run and all records will get pushed to the client instead of only the notified one.

#### once {boolean}
Push all records to the client once then do not push anything else even when notified

#### init: {function}
Provide a function for third parameters.  The params from the subscriptions might required additional parameters not known to the subscriber but necessary to the publication

      function init(tenantId, user, additionalParams) {
          additionalParams.tenantId = tenantId;
      }


### Zerv farm

If you run multiple zerv based application server instances (ex load balancing), all zerv instances must inter-communicate via a redis server.

Install a redis server and provide the following node environment variables to each instance:

    REDIS_ENABLED=true
    REDIS_HOST=<redis server ip or dns>
    REDIS_PORT=<redis server port>

The redis server must be reacheable from your instances.


### Zerv sync configuration

#### sync.setMaxDisconnectionTimeBeforeDroppingSubscription

By default, if the client does not restablish the connection in less than 20s, the server will drop the subscription and create a new one (fetching data from db) whehn the client reconnects.

#### sync.setDebug

by default, the backend does not show the log

### Collaborate

to run the test: npm test

Note: 
Increase constant CURRENT_SYNC_VERSION to prevent incompatible bower client libraries to operate.


### To Implement

#### object property change notification.
Publication shall have an option to be notified not only on object changes but even more precisely to the property level.
Then a publication shall only push an object to its subscribers when some specific object properties have changed.
This will reduce network activity and increase performance.

#### Always at the notification listener level
always parameter could also be implemented to be specific to some notifications (Publication Datanotification map)


