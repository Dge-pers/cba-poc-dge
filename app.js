/**
 * Copyright 2015 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

require( 'dotenv' ).config( {silent: true} );

var express = require( 'express' );  // app server
var bodyParser = require( 'body-parser' );  // parser for post requests
var watson = require( 'watson-developer-cloud' );  // watson sdk

var path = require('path');
global.appRoot = path.resolve(__dirname);

//Use a querystring parser to encode output.
var qs = require('qs');
var rq = require('request');
var fs = require('fs');
var util = require('util');

var multer  = require('multer')
var upload = multer({ dest: './temp/audioRec/' })

// The following requires are needed for logging purposes
var uuid = require( 'uuid' );
var vcapServices = require( 'vcap_services' );
var basicAuth = require( 'basic-auth-connect' );

//Create the service wrapper for T2S
var text_to_speech = watson.text_to_speech({
  url: "https://stream.watsonplatform.net/text-to-speech/api",
  username: "257cd165-4ab7-4661-9fa3-9c9b81579256",
  password: "D1oWZBP6BjwY",
  version: 'v1'
});

//Create the service wrapper for S2T
var speech_to_text = watson.speech_to_text({
  url: "https://stream.watsonplatform.net/speech-to-text/api",
  username: "61766daf-d629-4ad7-b5b2-bc12e33a617f",
  password: "MRGib5gFXZWV",
version: 'v1'
});

//Create the service wrapper for Conversation
var conversation = watson.conversation( {
	  url: "https://gateway.watsonplatform.net/conversation/api",
	  username: "37cfb8f4-b410-435b-b78c-48d55f7d3702",
	  password: "ioz0RxBEoJFG",
	  version_date: '2016-07-11',
	  version: 'v1'
	} );

//Create the service wrapper for Cloudant
var cloudantUrl =  "https://dbbae00b-626c-4fda-b351-c798534d9367-bluemix:426f9eede3ae2c43865fb1937f665dc4c684ae1a6d74bfefde4d6444eb7f9d26@dbbae00b-626c-4fda-b351-c798534d9367-bluemix.cloudant.com";
var cloudantUsr =  "dbbae00b-626c-4fda-b351-c798534d9367-bluemix";
var cloudantPass = "426f9eede3ae2c43865fb1937f665dc4c684ae1a6d74bfefde4d6444eb7f9d26";

//If the cloudantUrl has been configured then we will want to set up a nano client for each database
var nano = require('nano')(cloudantUrl);
var logDB = nano.db.use('olivia_conv_logs');
var ansDB = nano.db.use('olivia_db_answers');
var feedBackDB = nano.db.use('angie_db_feedback');

/*
//Create the service wrapper for Retrieve and Rank
var retrieve_and_rank = watson.retrieve_and_rank({
	  username: "",
	  password: "",
	  version: 'v1'
	});

var paramsRR = {
		  cluster_id: "",
		  collection_name: "",
		  wt: 'xslt'
		};
*/

var app = express();

// Bootstrap application settings
app.use( express.static( './public' ) ); // load UI from public folder
app.use( bodyParser.json() );

// Endpoint to be call from the client side
app.post('/api/message', function(req, res) {
  var workspace = "278b837a-c4b9-4af3-993a-190163c9d808";

  var payload = {
    workspace_id: workspace,
    context: {},
    input: {}
  };
  if ( req.body ) {
    if ( req.body.input ) {
      payload.input = req.body.input;
    }
    if ( req.body.context ) {
      // The client must maintain context/state
      payload.context = req.body.context;
    }
  }
  // Send the input to the conversation service
  conversation.message( payload, function(err, data) {
    if ( err ) {
      return res.status( err.code || 500 ).json( err );
    }
    return res.json( updateMessage(payload, data) );
  });
});

/**
 * Updates the response text using the intent confidence
 * @param  {Object} input The request to the Conversation service
 * @param  {Object} response The response from the Conversation service
 * @return {Object}          The response with the updated message
 */
function updateMessage(input, response) {
  var responseText = null;
  var id = null;
  if ( !response.output ) {
    response.output = {};
  } else {

    return response;
  }
  if ( response.intents && response.intents[0] ) {
    var intent = response.intents[0];

    if ( intent.confidence >= 0.75 ) {
      responseText = 'I understood your intent was ' + intent.intent;
    } else if ( intent.confidence >= 0.5 ) {
      responseText = 'I think your intent was ' + intent.intent;
    } else {
      responseText = 'I did not understand your intent';
    }
  }
  response.output.text = responseText;

  return response;
}

//Endpoint to be call for R&R
app.get('/api/retrieveandrank', function(req, res) {
  var solrClient = retrieve_and_rank.createSolrClient(paramsRR);
	
  var rankerID = ''; //Replace value if a ranker is available
  var query = qs.stringify({q: req.query.message, ranker_id: rankerID, fl: 'id,title,body,contentHtml,score'});
  
  solrClient.get('fcselect', query, function(err, searchResponse) {
	  if(err) {
	    console.log('Error searching for documents: ' + err);
	  }
	  else {
	    var topThreeRes = [searchResponse.response.docs[0],searchResponse.response.docs[1],searchResponse.response.docs[2]];
	    return res.json(topThreeRes);
	  }
	});  

});


// Endpoint to call for storing logs
app.get('/store/chats', function(request, response) {
  var name = request.query.name;
  var conv = request.query.conv;
  var comment = request.query.comment;
  var date = request.query.date;

  var chatRecord = {'name': name, 'conv' : conv, 'comment' : comment, 'date': date };
  logDB.insert(chatRecord, function(err, body, header) {
    if (!err) {
    	var logSubRedirect = 'https://angie.mybluemix.net/';
      	
		response.writeHead(302, {
		  'Location': logSubRedirect
		});
		response.end();
    }
  });
});

// Endpoint to call for viewing logs
app.get('/retrieve/chats', function(request, response) {
	
  logDB.view('chats', 'chats_index', function(err, body) {
  if (!err) {
    var chatLog = [];
      body.rows.forEach(function(doc) {
        chatLog.push(doc.value);
      });
    
      return response.json(chatLog);
    }
  else{
    return response.json(new Error(err));
	}
  });
 
});

// Endpoint to call for retrieving docs and answers
app.get('/retrieve/answer', function(request, response) {	
  ansDB.view('docs', 'docs_index', function(err, body) {
  if (!err) {
    var docInfo = [];
      body.rows.forEach(function(doc) {
        docInfo.push(doc.value);
      });
    
      return response.json(docInfo);
    }
  else{
    return response.json(new Error(err));
	}
  });
 
});

// Endpoint to call for retrieving answers doc binaries
app.get('/load/:docDir', function(req, res) {
  var url = cloudantUrl+'/angie_db_answers/'+Buffer(req.params.docDir, 'base64').toString();
  rq.get(url).pipe(res);
});

function B64DecodeUni(str) {
    return decodeURIComponent(Array.prototype.map.call(atob(str), function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
}

//Endpoint to call for T2S
app.post('/T2S/audio', function(req, res) {
  //var angieSays = Buffer(req.body.angieSays, 'base64').toString()
  var params = {
		  text: req.body.angieSays,
		  voice: 'fr-FR_ReneeVoice', //fr-FR_ReneeVoice expressive
		  accept: 'audio/ogg'
  };
  text_to_speech.synthesize(params).pipe(res);
});

//Endpoint to call for S2T
app.post('/S2T/record', upload.single('track'), function(req,res){
	var params = {
		audio: fs.createReadStream(appRoot+'/'+req.file.path),
    	content_type: 'audio/wav',
		model: 'fr-FR_BroadbandModel'
	};
	speech_to_text.recognize(params, function(error, transcript){
		if (error){
			res.status(500).write('\n\n' + error);
			res.end();
			console.log('error:', error);
		}
	    else{
	    	res.status(200).json(transcript).end();
		}		
		fs.unlinkSync(appRoot+'/'+req.file.path);
	});
});

//Endpoint to call for authentifications
app.get('/auth/check', function(request, response) {
  var match = 0;
  var usr = request.query.usrID;
  var psw = request.query.pswID;
  
  authDB.view('creds', 'creds_index', function(err, body) {
  if (!err) {
	  var usrCreds = [];
      body.rows.forEach(function(doc) {
    	usrCreds.push(doc.value);
      });
      
      for(var i=0; i<usrCreds.length; i++){
    	  if(usr == Buffer(usrCreds[i].cldUser, 'base64').toString() && psw == Buffer(usrCreds[i].cldPass, 'base64').toString()){
    		  match = 1;
    	  }
      }
	  return response.json(match);
    }
  else{
    return response.json(new Error(err));
	}
  });
});

//Endpoint to call for storing logs
app.get('/store/feedback', function(request, response) {
  var feedBackDoc={
		  date: new Date(),
		  conv: request.query.conv,
		  convLength: request.query.convLength,
		  feedback: request.query.feedback,
		  intent: request.query.intent,
		  entities: request.query.entities,
		  comment: request.query.comment
  }
  
  feedBackDB.insert(feedBackDoc, function(err, body){
    if (!err) {
    	return response.json('success');
    }
  });
});

module.exports = app;
