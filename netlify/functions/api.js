import { bech32 } from "@scure/base";
import TLV from "node-tlv";
import { marked } from "marked";
import { fileTypeFromBuffer } from "file-type";
import { WebSocket } from "ws";

function bech32ToHex(noteId) {

  var hexRegex = /^([0-9a-f]){64}$/;
 
  if(hexRegex.test(noteId)) {
    return noteId;
  }

  var bech32Regex = /^(npub|nsec|note|nevent|naddr|nprofile|nrelay){1}([a-z0-9]){1,255}$/;
 
  if(!bech32Regex.test(noteId)) {
    return noteId;
  }

  var decoded = bech32.decode(noteId, 1000);
  var bytes = new Uint8Array(bech32.fromWords(decoded.words));
  var hex = Buffer.from(bytes).toString("hex");
  
  if(["nevent","naddr","nprofile"].includes(decoded.prefix)) {

    var nip19 = {};

    var tlvParts = TLV.parseList(hex);

    for(var part of tlvParts) {
     
      if(part.tag == "00") {
        if(decoded.prefix == "naddr") {
          nip19.d = Buffer.from(part.value, "hex").toString("utf8");
        } else {
          nip19.id = part.value.toLowerCase();
        }
      }

      if(part.tag == "01") {
        nip19.relay = Buffer.from(part.value, "hex").toString("utf8");
      }

      if(part.tag == "02") {
        nip19.author = part.value.toLowerCase();
      }

      if(part.tag == "03") {
        nip19.kind = Buffer.from(part.value, "hex").readUInt32BE();
      }

    }

    if(nip19.id) {
      var hex = nip19.id;
    }

    if(nip19.d) {
      var hex = nip19.author+""+nip19.d;
    }

  }

  return hex;

}

function constructQuery(params) {

  if(!params.fetch || params.fetch == "note") {
 
    var noteId = bech32ToHex(params.note);

    if(!noteId) {
      return [];
    }

    if(params.note.slice(0,5) == "naddr") {
      var filter = { "authors": [noteId.slice(0,64)], "#d": [noteId.slice(64)], "limit": 1 };
    }

    if(params.note.slice(0,5) != "naddr") {
      var filter = { "ids": [noteId], "limit": 1 };
    }

    var query = ["REQ", "fetchNote", filter];

  }

  if(params.fetch == "comments") {

    var noteId = bech32ToHex(params.note);

    if(!noteId) {
      return [];
    }
 
    var filter = { "#e": [noteId], "kinds": [1, 1111], "limit": 20 };

    if(params.limit) {
      filter.limit = params.limit;
    }

    if(params.since) {
      filter.since = params.since;
    }

    var query = ["REQ", "fetchComments", filter];

  }

  if(params.fetch == "profile") {

    var pubKey = bech32ToHex(params.note);
 
    if(!pubKey) {
      return [];
    }

    var filter = { "authors": [pubKey], "kinds": [0], "limit": 1 };
    
    var query = ["REQ", "fetchProfile", filter];

  }

  if(params.fetch == "author") {

    var pubKey = bech32ToHex(params.note);

    if(!pubKey) {
      return [];
    }

    var filter = { "authors": [pubKey], "kinds": [1, 1111, 30023], "limit": 20 };

    if(params.limit) {
      filter.limit = params.limit;
    }

    if(params.since) {
      filter.since = params.since;
    }

    var query = ["REQ", "fetchNotesByAuthor", filter];

  }

  if(params.fetch == "search") {

    var searchTerms = params.note;
 
    if(!searchTerms) {
      return [];
    }
   
    var filter = { "search": searchTerms, "limit": 20 };

    if(params.limit) {
      filter.limit = params.limit;
    }

    if(params.since) {
      filter.since = params.since;
    }

    var query = ["REQ", "fetchNotesBySearchTerms", filter];

  }

  return query;
  
}

async function fetchNotes(relay, query) {

  try {
    var relay = "wss://"+relay;
    var validUrl = new URL(relay);
  } catch(err) {
    var relay = false;
  }

  if(!relay || !query) {
    return [];
  }

  var notes = await askNostr(relay, query);
  
  return notes;

}

function askNostr(relay, query) {

  return new Promise((resolve, reject) => {

    if(!relay || !query) {
      resolve([]);
    }

    var buffer = [];

    var ws = new WebSocket(relay);

    ws.on("open", function() {
      ws.send(
        JSON.stringify(query)
      );
    });

    ws.on("message", function(data) {

      var data = JSON.parse(data);
      var type = data[0];

      if(type == "EVENT" || type == "OK" || type == "NOTICE") {
        buffer.push(data);
      }
      
      if(type == "OK" || type == "NOTICE" || type == "EOSE") {
        ws.send(
          JSON.stringify(["CLOSE", query[1]])
        );
      };

      if(type == "OK" || type == "NOTICE" || type == "EOSE" || type == "CLOSED") {
        ws.close();
      };

    });

    ws.on("close", function() {
      resolve(buffer);
    });

    ws.on("error", function(err) {
      resolve(buffer);
    });

  });

}

async function formatContent(type, notes) {

  if(!type || type == "json") {

    var content = {
      type: "application/json",
      data: JSON.stringify(notes),
    }
  
  }

  if(type == "text") {

    var body = [];

    for(note of notes) {
   
      if(note[0] == "NOTICE" || note[0] == "OK") {
        body.push(note[1]);
      } 

      if(note[0] == "EVENT") {
        body.push(note[2]["content"]);
      }

    }

    var body = body.join("\r\n\r\n");

    var content = {
      type: "text/plain",
      data: body,
    }

  }

  if(type == "markdown") {

    var note = notes[0];

    if(note[0] == "NOTICE" || note[0] == "OK") {
      var markdown = note[1];
    } else if(note[0] == "EVENT") {
      var markdown = note[2]["content"];
    } else {
      var markdown = "";
    }

    if(note[0] == "EVENT") {
      var title = note[2]["tags"].find(o => o[0] == "title");
    }

    if(title) {
      var title = title[1];
      var markdown = `# ${title} \r\n\ ${markdown}`;
    } else {
      var title = markdown.slice(0,80)+"...";
    }

    var markdownToHTML = marked.parse(markdown);

    var html = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale="1.0">
    <title>${title}</title>
    <style>
      #markdown {
        margin: 20px auto;
        padding: 20px;
        max-width: 800px;
        font-family: sans-serif;
      }
      img {
        margin: 10px auto;
        max-width: 100%;
        height: auto;
      }
      pre, code {
        white-space: break-spaces;
        word-wrap: anywhere;
        max-width: 100%;
      }
    </style>
  </head>
  <body>
    <div id="markdown">${markdownToHTML}</div>
  </body>
</html>
  `;

    var content = {
      type: "text/html",
      data: html,
    }

  }

  if(type == "html") {

    var note = notes[0];

    if(note[0] == "NOTICE" || note[0] == "OK") {
      var html = note[1];
    } else if(note[0] == "EVENT") {
      var html = note[2]["content"];
    } else {
      var html = "";
    }
    
    var content = {
      type: "text/html",
      data: html,
    }

  }

  if(type == "file") {

    var note = notes[0];

    if(note[0] == "NOTICE" || note[0] == "OK") {
      var base64 = note[1];
    } else if(note[0] == "EVENT") {
      var base64 = note[2]["content"];
    } else {
      var base64 = "";
    }

    var dataURIRegex = /^data:([a-z0-9]*\/[a-z0-9]*);base64,([a-zA-Z0-9+\/=]*)$/;

    var isDataURI = base64.match(dataURIRegex);

    if(isDataURI) {
 
      var mimeType = isDataURI[1];

      var bytes = Buffer.from(isDataURI[2], "base64");

    }

    if(!isDataURI) {

      var base64Regex = /^([a-zA-Z0-9+\/=]*)$/;

      var isBase64 = base64.match(base64Regex);

      if(isBase64) {
      
        var bytes = Buffer.from(isBase64[0], "base64");

        var fileType = await fileTypeFromBuffer(bytes);

        if(fileType) {

          var mimeType = fileType.mime;

        } else {

          var mimeType = "application/octet-stream";

        }

      }

      if(!isBase64) {
      
        var bytes = base64;

        var mimeType = "text/plain";

      }

    }

    var content = {
      type: mimeType,
      data: bytes,
    }

  }

  return content;

}

function getRoute(url) {

  var url = url.split("/");

  var params = {};

  if(url[1] == "json") {

    params.return = url[1];
    params.fetch = url[2];
    params.relay = url[3];
    params.note = url[4];

    if(url[5]) {
      params.limit = url[5].replace("limit-", "");
    }

    if(url[6]) {
      params.since = url[6].replace("since-", "");
    }

  }

  if(["text","markdown","html","file"].includes(url[1])) {

    params.return = url[1];
    params.relay = url[2];
    params.note = url[3];

  }

  return params;

}

exports.handler = async function(event, context) {

  try {

    var params = getRoute(event.path);

    var query = constructQuery(params);

    var notes = await fetchNotes(params.relay, query);

    var content = await formatContent(params.return, notes);

  } catch(err) {

    var content = {
      type: "application/json",
      data: JSON.stringify(["error"]),
    };
  
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": content.type+"; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
    body: content.data,
  };

};
