# service-builder
Build service

All jobs that this service use are `kue` processes.

This service to called after the git server has processed the git push. 

## Run

RUN NOTES:
- This process can be run in the system.
- Can be run as a standalone.

```
node build.js /path/to/config/file.json
```

## build
Build an application with a buildpack 
- `organization` 	String Organization name found in MongoDB
- `name` 					String Application name linked to the Organization.
- `commit` 				String MongoDB `ObjectId` for the commit document.
- `proc` 					Object `Procfile` Data from the Procfile oof the application.
### Result
	Returns MongoDB build document or an error.
	```
	{
	    "_id" : ObjectId("5a3af56fb0a5d27ecf617a35"),
	    "organization" : ObjectId("5a3ad9edca8e433c70fc932b"),
	    "app" : ObjectId("5a3ada51ca8e433c70fc932f"),
	    "process" : 43,
	    "commit" : ObjectId("5a3af5021e36ff50833cfcd7"),
	    "container" : ObjectId("5a3af50325b28b7e75848624"),
	    "name" : "logger",
	    "build" : ObjectId("5a3af56fb0a5d27ecf617a33"),
	    "application" : ObjectId("5a3af56fb0a5d27ecf617a32"),
	    "cache" : ObjectId("5a3af56fb0a5d27ecf617a34"),
	    "version" : 0,
	    "created_at" : ISODate("2017-12-20T23:42:39.154Z"),
	    "procfile" : [ 
	        {
	            "command" : "node",
	            "process" : "web",
	            "_id" : ObjectId("5a3af56fb0a5d27ecf617a36"),
	            "options" : [ 
	                "index.js"
	            ]
	        }
	    ],
	    "failed" : false,
	    "is_active" : true,
	    "__v" : 0
	}
	```
	
# EVENTS
Events this service emits.

## builder.start
	Data is just the `job.data` object.

## builder.error
	Errors that might come up in the build process. 
	This is ontop of the errors that are sent back to the caller.

