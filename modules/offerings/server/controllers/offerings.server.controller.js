/* indent: 0 */
'use strict';

/**
 * Module dependencies.
 */
var path = require('path'),
  mongoose = require('mongoose'),
  Offering = mongoose.model('Offering'),
  translater = require(path.resolve('./modules/language/server/watson/language.server.watson.translation')),
  config = require(path.resolve('./config/config')),
  extend = require('util')._extend,
  errorHandler = require(path.resolve('./modules/core/server/controllers/errors.server.controller'));


// Helper function to translate, save, and return an offering
function doTranslateOfferingAndSave(offering, res) {
  var translateInput = {
    substituteOnFailure: true,
    sourceLanguage: offering.descriptionLanguage,
    sourceText: offering.description
  };
  translater.translateAllLanguages(translateInput, function(translationOutput) {
    translationOutput.targets.forEach(function(translation) {
      // TODO: This needs a redesign!  The offering.description should
      // have an array of translated languages, we should not have 3
      // hard-coded and ugly fields.
      if (translation.language === 'en') {
        offering.descriptionEnglish = translation.text;
      } else if (translation.language === 'ar') {
        offering.descriptionOther = translation.text;
      }
    });
    offering.save(function (err) {
      if (err) {
        return res.status(400).send({
          message: errorHandler.getErrorMessage(err)
        });
      } else {
        var filteredOffering = Offering.getPublicObject(offering, true, false);
        res.json(filteredOffering);
      }
    });
  });
}

function translateAllOfferings(offerings, desiredLanguage)
{
  offerings.forEach(function(offering) {
    if (desiredLanguage === offering.descriptionLanguage) {
      // no-op, offering.description is already in the correct language
    } else if (desiredLanguage === 'en') {
      // Use the copy we have already translated to english
      if (offering.descriptionEnglish) {
        offering.description = offering.descriptionEnglish;
      }
      // else, must have been created before translations, return un-translated
    } else {
      // if it's not english, and not the source language, must be the
      // 'other' language.  This only works with 3 supported languages.
      // If we need to support more languages, we may need to translate
      // on the fly for queries....
      if (offering.descriptionOther) {
        offering.description = offering.descriptionOther;
      }
      // else, must have been created before translations, return un-translated
    }
  });
  return offerings;
}

/**
 * Re-build indexes.  geoNear queries require an index to be created, and
 * mongoose only creates indexes at startup.  So, if the offerings collection
 * is dropped, the indexes won't be rebuilt until startup, causing all geoNear
 * queries to fail with a 16604 error code until the app is restarted.  To
 * workaround this, rebuild the indexes manually if errors are encountered.
 */
function rebuildOfferingIndexes() {
  Offering.ensureIndexes(function(err) {
    if (err) { 
      console.log('Offering: error rebuilding indexes: ' + err); 
    } else {
      console.log('Offering: indexes re-built succesfully.');
    } 
  });
}

/**
 * Create a offering
 */
exports.create = function (req, res) {
  var offering = new Offering();
  offering.user = req.user;
  offering.ownerId = req.user._id.toString();
  offering.when = new Date(req.body.whenString);
  var now = new Date(); 
  offering.updated = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds());
  offering.expiry = new Date(req.body.expiryString);
  offering.descriptionLanguage = req.body.descriptionLanguage;
  offering.description = req.body.description;
  offering.descriptionDetails = req.body.descriptionDetails;
  offering.city = req.body.city;
  offering.category = req.body.category;
  offering.loc.type = 'Point';
  offering.loc.coordinates = [ Number(req.body.longitude),
                               Number(req.body.latitude) ];
  offering.offerType = Offering.mapOfferTypeStringToNumber(req.body.offerType);
  offering.numOffered = req.body.numOffered ? Number(req.body.numOffered) : 1;
  doTranslateOfferingAndSave(offering, res);

};

/**
 * Show the current offering
 */
exports.read = function (req, res) {
  res.json(req.offering);
};

/**
 * Update a offering
 */
exports.update = function (req, res) {
  Offering.findOne({ _id: mongoose.Types.ObjectId(req.offering._id) }, function (err, offering){
    if (err) {
      return res.status(400).send({ message: errorHandler.getErrorMessage(err) });
    } else {
      offering.user = req.user;
      offering.ownerId = req.user._id.toString();
      offering.when = new Date(req.body.whenString);
      var now = new Date(); 
      offering.updated = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds());
      offering.expiry = new Date(req.body.expiryString);
      offering.description = req.body.description;
      offering.descriptionLanguage = req.body.descriptionLanguage;
      offering.city = req.body.city;
      offering.category = req.body.category;
      offering.loc.type = 'Point';
      offering.loc.coordinates = [ Number(req.body.longitude),
                                   Number(req.body.latitude) ];

      doTranslateOfferingAndSave(offering, res);
    }
  });
};

/**
 * Delete an offering
 */
exports.delete = function (req, res) {
  Offering.remove({ _id: mongoose.Types.ObjectId(req.offering._id) }, function(err) {
    if (err) {
      return res.status(400).send({ message: errorHandler.getErrorMessage(err) });
    } else {
      res.json(req.offering);
    }
  });
};

function buildGeoNearAggregateRestriction(req) {
  var restrictQuery = {};
  // TODO: The additional fields that can/should be used for the query are:
  // req.body.description -- description of the offering the user is searching for
  // req.body.whenString -- UTC date string the user is interested in receiving offers for
  restrictQuery.maxDistance = req.query.radius*1000;
  restrictQuery.spherical = true;
  restrictQuery.distanceMultiplier = 1/1000;
  // if any categories were selected, restrict on those
  if (req.query.category) {
    var searchCategories = [];
    if (typeof req.query.category === 'string') {
      searchCategories.push(req.query.category);
    } else {
      searchCategories = req.query.category;
    }
    restrictQuery.query = { category: { $in: searchCategories } };
  }
  if (req.query.offerType) {
    var offerTypeRestrict = Offering.mapOfferTypeStringToNumber(req.query.offerType);
    if (restrictQuery.query) {
      restrictQuery.query.offerType = offerTypeRestrict;
    } else {
      restrictQuery.query = { offerType: offerTypeRestrict };
    }
  }
  var nearPoint = { type : 'Point', coordinates : [ Number(req.query.longitude), Number(req.query.latitude) ] };
  restrictQuery.near = nearPoint;
  restrictQuery.distanceField = 'distance';
  return restrictQuery;
}

function filterInternalOfferingFields(rawDocs, myOwnDoc, includeDistance) {
  var filteredResults = [];
  rawDocs.forEach(function(rawDoc) {
    // Skip invalid offerings that do not have any associated user
    if (rawDoc.user && rawDoc.user._id) {
      filteredResults.push(Offering.getPublicObject(rawDoc, myOwnDoc, includeDistance));
    }
  });
  return filteredResults;
}

/**
 * List of Offerings
 */
exports.listMine = function (req, res) {
  var Query = (req.user) ? { 'ownerId': req.user._id.toString() } : {};

  if (req.query.radius) {
    // We were passed in fields implying a record-search should be performed.
    var restriction = buildGeoNearAggregateRestriction(req);
    // Run the query, and then do some post-query filtering
    Offering.aggregate([
      { '$geoNear': restriction },
      { '$skip': 0 },
      { '$limit': 25 },
      { '$sort': { 'distance': 1 } } // Sort the nearest first
    ], function(err,offerings) {
      if (err) {
        // On error, try to rebuild the index, required by geoNear, so hopefully
        // the next attempt will succeed.
        rebuildOfferingIndexes();
        return res.status(400).send({ message: errorHandler.getErrorMessage(err) });
      } else {
        // Populate the display name of the user that created this offering.
        Offering.populate(offerings, { path: 'user' }, function(err,docs) {
          if (err) {
            return res.status(400).send({ message: errorHandler.getErrorMessage(err) });
          } else {
            //console.log('RAW RESULTS: ' + JSON.stringify(docs));
            // restrict results to only public-viewable fields
            var publicResults = filterInternalOfferingFields(docs, false, true);
            //console.log('RETURNING: ' + JSON.stringify(publicResults));
            // Translate results into the desired language
            publicResults = translateAllOfferings(publicResults, req.query.descriptionLanguage);
            res.json(publicResults);
          }
        });
      }
    });
  } else {
    // Build up query, depending on whether the user is authenticated or not.  Authenticated
    // users are returned a list of all their offerings.  Non-authenticated users get
    // a sampling of 5 (random) offerings - the limit is to reduce load on the server.
    // Note that currently only unit tests call this without authentication, normally
    // non-authenticated users go through the search path above.
    var query = Offering.find({});
    // TODO: If user is admin, then return all offerings? use results pagination?
    if (req.user) {
      query.where('ownerId', req.user._id.toString());
      query.sort('-created');
    } else {
      query.limit(5);
    }
    query.populate('user');

    query.exec(function (err, offerings) {
      if (err) {
        return res.status(400).send({ message: errorHandler.getErrorMessage(err) });
      } else {
        // console.log('RAW RESULTS for ' + JSON.stringify(Query) + ' : ' + JSON.stringify(offerings));
        // restrict results to only public-viewable fields
        var publicResults = filterInternalOfferingFields(offerings, true, false);
        // Note - these results do not go through translation services, they are
        // returned the same way the user entered them.
        res.json(publicResults);
      }
    });
  }
};

/**
 * Offering middleware
 */
exports.offeringByID = function (req, res, next, id) {

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).send({ message: 'Offering is invalid' });
  }

  Offering.findById(id).populate('user').exec(function (err, offering) {
    if (err) {
      return next(err);
    } else if (!offering) {
      return res.status(404).send({ message: 'No offering with that identifier has been found' });
    }
    var myDoc = (req.user && req.user._id && req.user._id.toString() === offering.user._id.toString());
    req.offering = offering.getPublicObject(myDoc);
    next();
  });
};
