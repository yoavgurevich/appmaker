/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var knox = require('knox');
var moniker = require('moniker');
var ejs = require('ejs');
var fs = require('fs');
var path = require('path');
var lynx = require('lynx');
var metrics = new lynx('localhost', 8125);
var dbModels = require('../lib/db-models');

module.exports = function (store, viewsPath, urlManager, makeAPIPublisher, dbconn) {
  var Component = dbModels.get('Component');
  var App = dbModels.get('App');

  var templates = {
    publish: null,
    install: null
  };

  var icons = {};

  [60, 79, 128].forEach(function (iconSize) {
    var iconFilename = __dirname + '/../public/images/app-icon-' + iconSize + '.png';
    fs.readFile(iconFilename, function (err, iconData) {
      if (err) {
        console.warn('Could not load icon at ' + iconFilename + ' .');
      }
      else {
        icons[iconSize] = {
          filename: 'app-icon-' + iconSize + '.png',
          data: iconData
        }
      }
    });
  });

  fs.readFile(viewsPath + '/publish.ejs', 'utf8', function (err, publishHTMLData) {
    templates.publish = ejs.compile(publishHTMLData, {
      // for partial include access
      filename: viewsPath + '/publish.ejs'
    });
  });

  fs.readFile(viewsPath + '/install.ejs', 'utf8', function (err, installHTMLData) {
    templates.install = ejs.compile(installHTMLData, {
      // for partial include access
      filename: viewsPath + '/publish.ejs'
    });
  });

  function getUserComponents (req, callback) {
    if (!process.env.ALLOW_CUSTOM_COMPONENTS) {
      callback([]);
      return;
    }

    if (! req.session.email) {
      console.warn('Need to be signed in to retrieve components.');
      callback([]);
      return;
    }
    Component.find({author: req.session.email}, function (err, components) {
      if (err){
        console.warn('Unable to retrieve components.');
        callback([]);
        return;
      }
      callback(components.map(function (c) {
        return c.url;
      }));
    });
  }

  return {
    publish: function(app) {
      return function(req, res) {

        var folderName = moniker.choose() + '-' + Math.round(Math.random() * 1000);
        var userName = req.session.user.username;
        var installHTMLFilename =  'install';
        var appHTMLFilename = 'app';
        var manifestFilename = 'manifest.webapp';

        var remoteURLPrefix = urlManager.createURLPrefix(folderName);
        var launchPath = urlManager.createLaunchPath(folderName);

        var remoteURLs = {
          install: remoteURLPrefix + installHTMLFilename,
          app: remoteURLPrefix + appHTMLFilename,
          manifest: remoteURLPrefix + manifestFilename
        };

        var inputData = req.body;
        var manifest = inputData.manifest || {};

        function cleanString (str, removeQuotes) {
          str = str.replace(/>/g, '&gt;').replace(/</g, '&lt;');
          if (removeQuotes) {
            str = str.replace(/'/g, '').replace(/"/g, '')
          }
          return str;
        }

        // core appmaker components
        var coreComponents = app.locals.components;
        var appComponents = [
          //... mine the requestHTML for these? ...
        ];

        var remixUrl = encodeURIComponent(encodeURIComponent(remoteURLs.app));
        getUserComponents(req, function (userComponents) {

          var appDescription = inputData.appDescription || "";
          var appName = inputData.name || req.gettext('My App') + ' - ' + folderName;
          var appStr = templates.publish({
            appHTML: inputData.html,
            folderName: folderName,
            appName: appName,
            gettext: req.gettext,
            ceciComponentURL: process.env.ASSET_HOST,
            bundles: app.locals.bundles,
            components: coreComponents.concat(appComponents),
            userComponents: userComponents,
            manifestUrl: remoteURLs.manifest,
            username: userName,
            description: appDescription,
            remixUrl : remoteURLs.app
          });

          var installStr = templates.install({
            iframeSrc: remoteURLs.app,
            manifestUrl: remoteURLs.manifest,
            gettext: req.gettext,
            appname: appName,
            username: userName,
            description: appDescription,
            webmakerurl: process.env.WEBMAKER_URL || ""
          });

          var manifestJSON = {
            "name": appName,
            "description": appDescription,
            "launch_path": launchPath,
            "developer": {
              "name": "App Maker",
              "url": "https://appmaker.mozillalabs.com/"
            },
            "icons": {
            },
            "default_locale": "en",
            "permissions": {
              "audio-capture": {
                "description": "We'd like to use your microphone"
              },
              "video-capture": {
                "description": "We'd like to use your camera"
              }
            }
          };

          var iconFiles = Object.keys(icons).map(function (iconSize) {
            var icon = icons[iconSize];
            manifestJSON.icons[iconSize] = urlManager.createIconPath(folderName, icon.filename);
            return {filename: urlManager.objectPrefix + '/' + folderName + '/' + icons[iconSize].filename,
              data: icons[iconSize].data, contentType: 'image/png'};
          });

          var outputFiles = [
            {filename: urlManager.objectPrefix + '/' + folderName + '/' + manifestFilename,
              data: JSON.stringify(manifestJSON),
              // According to https://developer.mozilla.org/en-US/docs/Web/Apps/Manifest#Serving_manifests
              contentType: 'application/x-web-app-manifest+json'},
            {filename: urlManager.objectPrefix + '/' + folderName + '/' + appHTMLFilename,
              data: appStr},
            {filename: urlManager.objectPrefix + '/' + folderName + '/' + installHTMLFilename,
              data: installStr}
          ].concat(iconFiles);

          var filesDone = 0;

          var setObj = {
            'published-date': new Date()
          };

          App.update({
              author: req.session.email,
              name: inputData.name
            }, {
              $set: setObj
            }, {},
            function(err,obj){
              if(err){
                console.warn('Error saving published date to database: ' + err);
              }
            }
          );
          outputFiles.forEach(function (description) {

            store.write(description.filename, description.data, function (result) {
              if (200 !== result.statusCode) {
                console.warn('Trouble writing ' + description.filename + ' to S3 (' + result.statusCode + ').');
              }
              if (++filesDone === outputFiles.length) {
                res.json({error: null,
                  app: remoteURLs.app,
                  install: remoteURLs.install,
                  manifest: remoteURLs.manifest
                }, 200);
                // Don't wait for the MakeAPI to deliver url to user
                App.findOne({
                  author: req.session.email,
                  name: inputData.name
                }, function(err, app) {
                  if (err) {
                    return console.warn('Error finding app for publishing to MakeAPI: ' + err);
                  }
                  var publishOptions = {
                    url: remoteURLs.install,
                    remix: remixUrl,
                    thumbnail: process.env.ASSET_HOST + "/images/app-icon.png",
                    title: appName,
                    appDescription: appDescription,
                    appTags: inputData.appTags || "",
                    remixedFrom: inputData.remixedFrom,
                    email: req.session.email,
                    author: userName,
                    locale: req.localeInfo.lang
                  };

                  if (app) {
                    publishOptions.id = app['makeapi-id'];
                  }

                  makeAPIPublisher.publish(publishOptions, function (err, make) {
                    if (err) {
                      console.warn(err);
                    }
                    else if (!publishOptions.id) {
                      App.update({
                        author: req.session.email,
                        name: inputData.name
                      }, {
                        $set: { 'makeapi-id': make.id }
                      }, {},
                      function(err,obj){
                        if(err){
                          console.warn('Error saving MakeAPI id to database: ' + err);
                        }
                      });
                    }
                  });
                });
              }
            }, description.contentType);
          });
          metrics.increment('appmaker.live.app_published');
        });
      };
    }
  };
};
