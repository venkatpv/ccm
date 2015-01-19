var log = logging.handle("methods");

var throwIfNotVerifiedUser = function(userId) {
  if(!userId) {
    throw new Meteor.Error(401, "Must log in");
  }

  var user = Meteor.users.findOne({ _id: userId });
  if(!user.emails[0].verified) {
    throw new Meteor.Error(401, "Must verify email");
  }
};

var throwIfNotSiteAdmin = function(userId) {
  if(!userId) {
    throw new Meteor.Error(401, "Must log in");
  }

  var user = Meteor.users.findOne({ _id: userId });
  if(!user.siteAdmin) {
    throw new Meteor.Error(401, "Must be a site admin");
  }
};

Meteor.methods({
  createCompetition: function(competitionName) {
    check(competitionName, String);
    if(competitionName.trim().length === 0) {
      throw new Meteor.Error(400, "Competition name must be nonempty");
    }
    throwIfNotVerifiedUser(this.userId);

    var competitionId = Competitions.insert({
      competitionName: competitionName,
      listed: false,
      startDate: new Date(),
    });

    var user = Meteor.users.find({ _id: this.userId });
    if(!user.profile) {
      throw new Meteor.Error(400, "Must set up user profile");
    }
    if(!user.profile.name) {
      throw new Meteor.Error(400, "Name must be nonempty");
    }
    if(!user.profile.dob) {
      throw new Meteor.Error(400, "DOB must be nonemtpy");
    }
    if(!user.profile.countryId) {
      throw new Meteor.Error(400, "Country must be nonemtpy");
    }
    if(!user.profile.gender) {
      throw new Meteor.Error(400, "Gender must be nonemtpy");
    }
    Registrations.insert({
      competitionId: competitionId,
      userId: this.userId,
      uniqueName: uniqueName,
      registeredEvents: [],
      organizer: true,
      wcaId: user.profile.wcaId,
      countryId: user.profile.countryId,
      gender: user.profile.gender,
      dob: user.profile.dob,
    });
    return competitionId;
  },
  deleteCompetition: function(competitionId) {
    check(competitionId, String);
    throwIfCannotManageCompetition(this.userId, competitionId);

    Competitions.remove({ _id: competitionId });
    Rounds.remove({ competitionId: competitionId });
    Results.remove({ competitionId: competitionId });
    Groups.remove({ competitionId: competitionId });
    Registrations.remove({ competitionId: competitionId });
  },
  addRound: function(competitionId, eventCode) {
    if(!canAddRound(this.userId, competitionId, eventCode)) {
      throw new Meteor.Error(400, "Cannot add another round");
    }

    // TODO - what happens if multiple users call this method at the same time?
    // It looks like meteor makes an effort to serve methods from a single user
    // in order, but I don't know if there is any guarantee of such across users
    // See http://docs.meteor.com/#method_unblock.

    var formatCode = wca.formatsByEventCode[eventCode][0];
    Rounds.insert({
      competitionId: competitionId,
      eventCode: eventCode,
      formatCode: formatCode,

      // These will be filled in by refreshRoundCodes, but
      // add valid value so the UI doesn't crap out.
      roundCode: 'f',
      nthRound: wca.MAX_ROUNDS_PER_EVENT,
    });

    Meteor.call('refreshRoundCodes', competitionId, eventCode);
  },
  addNonEventRound: function(competitionId, round) {
    check(competitionId, String);
    throwIfCannotManageCompetition(this.userId, competitionId);
    Rounds.insert({
      competitionId: competitionId,
      title: round.title,
      startMinutes: round.startMinutes,
      durationMinutes: round.durationMinutes,
    });
  },
  // TODO - i think this would be a bit cleaner if we just had a
  // removeLastRoundForEvent method or something. This might
  // require pulling non wca-event rounds out into a
  // separate collection.
  removeRound: function(roundId) {
    if(!canRemoveRound(this.userId, roundId)) {
      throw new Meteor.Error(400, "Cannot remove round. Make sure it is the last round for this event, and has no times entered.");
    }

    var round = Rounds.findOne({ _id: roundId });
    assert(round); // canRemoveRound checked that roundId is valid

    Rounds.remove({ _id: roundId });
    Groups.remove({ roundId: roundId });

    if(round.eventCode) {
      Meteor.call('refreshRoundCodes', round.competitionId, round.eventCode);

      // Deleting a round affects the set of people who advanced
      // from the previous round =)
      var previousRound = Rounds.findOne({
        competitionId: round.competitionId,
        eventCode: round.eventCode,
        nthRound: round.nthRound - 1,
      }, {
        fields: {
          _id: 1,
        }
      });
      if(previousRound) {
        Meteor.call('recomputeWhoAdvanced', previousRound._id);
      }
    }
  },
  refreshRoundCodes: function(competitionId, eventCode) {
    var rounds = Rounds.find({
      competitionId: competitionId,
      eventCode: eventCode
    }, {
      sort: {
        nthRound: 1,
        softCutoff: 1,
      }
    }).fetch();
    if(rounds.length > wca.MAX_ROUNDS_PER_EVENT) {
      throw new Meteor.Error(400, "Too many rounds");
    }
    rounds.forEach(function(round, index) {
      // Note that we ignore the actual value of nthRound, and instead use the
      // index into rounds as the nthRound. This defragments any missing
      // rounds (not that that's something we expect to ever happen, since
      // removeRound only allows removal of the latest round).
      var supportedRoundsIndex;
      if(index == rounds.length) {
        supportedRoundsIndex = wca.MAX_ROUNDS_PER_EVENT - 1;
      } else {
        supportedRoundsIndex = index;
      }
      var roundCodes = wca.supportedRounds[supportedRoundsIndex];
      assert(roundCodes);
      var roundCode = round.softCutoff ? roundCodes.combined : roundCodes.uncombined;
      Rounds.update({
        _id: round._id,
      }, {
        $set: {
          roundCode: roundCode,
          nthRound: index + 1,
        }
      });
    });
  },
  addOrUpdateGroup: function(newGroup) {
    throwIfCannotManageCompetition(this.userId, newGroup.competitionId);
    var round = Rounds.findOne({ _id: newGroup.roundId });
    if(!round) {
      throw new Meteor.Error("Invalid roundId");
    }
    throwIfCannotManageCompetition(this.userId, round.competitionId);

    var existingGroup = Groups.findOne({
      roundId: newGroup.roundId,
      group: newGroup.group,
    });
    if(existingGroup) {
      log.l0("Clobbering existing group", existingGroup);
      Groups.update({
        _id: existingGroup._id,
      }, {
        $set: newGroup,
      });
    } else {
      Groups.insert(newGroup);
    }
  },
  advanceCompetitorsFromRound: function(competitorCount, roundId) {
    var competitionId = getRoundAttribute(roundId, 'competitionId');
    throwIfCannotManageCompetition(this.userId, competitionId);

    var results = Results.find({
      roundId: roundId,
    }, {
      sort: {
        position: 1,
      },
      fields: {
        userId: 1,
        uniqueName: 1,
      },
    }).fetch();
    if(competitorCount < 0) {
      throw new Meteor.Error(400,
            'Cannot advance a negative number of competitors');
    }
    if(competitorCount > results.length) {
      throw new Meteor.Error(400,
            'Cannot advance more people than there are in round');
    }
    var eventCode = getRoundAttribute(roundId, 'eventCode');
    var nthRound = getRoundAttribute(roundId, 'nthRound');
    var nextRound = Rounds.findOne({
      competitionId: competitionId,
      eventCode: eventCode,
      nthRound: nthRound + 1,
    }, {
      fields: {
        _id: 1,
      }
    });
    if(!nextRound) {
      throw new Meteor.Error(404,
            'No next round found for roundId ' + roundId);
    }

    var desiredUserIds = [];
    var uniqueNameByUserId = {};
    for(var i = 0; i < competitorCount; i++) {
      var result = results[i];
      desiredUserIds.push(result.userId);
      uniqueNameByUserId[result.userId] = result.uniqueName;
    }

    var actualUserIds = _.pluck(Results.find({
      roundId: nextRound._id,
    }, {
      fields: {
        userId: 1,
      }
    }).fetch(), 'userId');

    var userIdsToRemove = _.difference(actualUserIds, desiredUserIds);
    var userIdsToAdd = _.difference(desiredUserIds, actualUserIds);

    // We're ready to actually advance competitors to the next round!

    // First, remove any results that are currently in the next round that
    // shouldn't be.
    _.each(userIdsToRemove, function(userId) {
      Results.remove({
        competitionId: competitionId,
        roundId: nextRound._id,
        userId: userId,
      });
    });

    // Now copy competitorCount results from the current round to the next
    // round.
    _.each(userIdsToAdd, function(userId) {
      Results.insert({
        competitionId: competitionId,
        roundId: nextRound._id,
        userId: userId,
        uniqueName: uniqueNameByUserId[userId],
      });
    });
    Meteor.call('recomputeWhoAdvanced', roundId);
  },
  checkInRegistration: function(registrationId) {
    // This method is called to either check-in a competitor for the first time,
    // or to update their check-in because the set of events they are registered for
    // changed. The latter may involve deleting results with data entered, so
    // be sure before you call this method =).
    var registration = Registrations.findOne({
      _id: registrationId,
    }, {
      fields: {
        competitionId: 1,
        uniqueName: 1,
        registeredEvents: 1,
        checkedInEvents: 1,
      }
    });
    throwIfCannotManageCompetition(this.userId, registration.competitionId);

    function getFirstRoundForEvent(eventCode) {
      var round = Rounds.findOne({
        competitionId: registration.competitionId,
        eventCode: eventCode,
        nthRound: 1,
      }, {
        fields: {
          _id: 1,
        }
      });
      return round;
    }
    var toUnCheckInTo = _.difference(registration.checkedInEvents, registration.registeredEvents);
    toUnCheckInTo.forEach(function(eventCode) {
      var round = getFirstRoundForEvent(eventCode);
      assert(round);
      Results.remove({
        roundId: round._id,
        registrationId: registration._id,
      });
    });

    var toCheckInTo = _.difference(registration.registeredEvents, registration.checkedInEvents);
    toCheckInTo.forEach(function(eventCode) {
      var round = getFirstRoundForEvent(eventCode);
      assert(round);
      Results.insert({
        competitionId: registration.competitionId,
        roundId: round._id,
        registrationId: registration._id,
        uniqueName: registration.uniqueName,
      });
    });
    Registrations.update({
      _id: registration._id,
    }, {
      $set: {
        checkedInEvents: registration.registeredEvents,
      }
    });
  },
  addSiteAdmin: function(newSiteAdminUserId) {
    var siteAdmin = getUserAttribute(this.userId, 'siteAdmin');
    if(!siteAdmin) {
      throw new Meteor.Error(403, "Must be a site admin");
    }

    Meteor.users.update({
      _id: newSiteAdminUserId,
    }, {
      $set: {
        siteAdmin: true,
      }
    });
  },
  removeSiteAdmin: function(siteAdminToRemoveUserId) {
    var siteAdmin = getUserAttribute(this.userId, 'siteAdmin');
    if(!siteAdmin) {
      throw new Meteor.Error(403, "Must be a site admin");
    }

    // Prevent a user from accidentally depromoting themselves.
    if(this.userId == siteAdminToRemoveUserId) {
      throw new Meteor.Error(403, "Site admins may not unresign themselves!");
    }

    Meteor.users.update({
      _id: siteAdminToRemoveUserId,
    }, {
      $set: {
        siteAdmin: false,
      }
    });
  },
});

if(Meteor.isServer) {
  var child_process = Npm.require('child_process');
  var path = Npm.require("path");
  var fs = Npm.require('fs');
  var os = Npm.require('os');
  var mkdirp = Meteor.npmRequire('mkdirp');

  var zipIdToFilename = function(zipId, userId) {
    var tmpdir = os.tmpdir();
    var filename = path.join(tmpdir, "tnoodlezips", userId, zipId + ".zip");
    return filename;
  };

  Meteor.methods({
    requestVerificationEmail: function() {
      Accounts.sendVerificationEmail(this.userId);
    },
    uploadTNoodleZip: function(zipData) {
      // TODO - this is pretty janky. What if the folder we try to create
      // exists, but isn't a folder? Permissions could also screw us up.
      // Ideally we would just decompress the zip file client side, but
      // there aren't any libraries for that yet.
      var id = Date.now();
      var zipFilename = zipIdToFilename(id, this.userId);
      mkdirp.sync(path.join(zipFilename, ".."));
      fs.writeFileSync(zipFilename, zipData, 'binary');
      return id;
    },
    unzipTNoodleZip: function(zipId, pw) {
      var args = [];
      args.push('-p'); // extract to stdout

      // If you don't pass -P to unzip and try to unzip a password protected
      // zip file, it will prompt you for a password, causing the unzip process
      // to hang. By always passing something to -P, we will never get prompted
      // for a password, instead unzip may just fail to extract.
      args.push('-P');
      args.push(pw || "");

      var zipFilename = zipIdToFilename(zipId, this.userId);
      args.push(zipFilename);
      args.push('*.json'); // there should be exactly one json file in the zip
      function unzipAsync(cb) {
        child_process.execFile('unzip', args, function(error, stdout, stderr) {
          if(error) {
            // Error code 82 indicates bad password
            // See http://www.info-zip.org/FAQ.html
            if(error.code == 82) {
              cb("invalid-password");
            } else {
              cb("Unzip exited with error code " + error.code);
            }
          } else {
            cb(null, stdout);
          }
        });
      }
      var unzipSync = Meteor.wrapAsync(unzipAsync);
      try {
        var jsonStr = unzipSync();
        return jsonStr;
      } catch(e) {
        throw new Meteor.Error('unzip', e.message);
      }
    },
    uploadCompetition: function(wcaCompetition) {
      throwIfNotSiteAdmin(this.userId);

      var competitionName = wcaCompetition.competitionId;
      var newCompetition = {
        competitionName: competitionName,
        listed: false,
        startDate: new Date(),
      };

      var wcaCompetitionId = wcaCompetition.competitionId;
      var existingCompetition = Competitions.findOne({ wcaCompetitionId: wcaCompetitionId });
      // Only set a wca competition id if a competition does not yet exist
      // with this wca competition id.
      if(!existingCompetition) {
        newCompetition.wcaCompetitionId = wcaCompetitionId;
      }
      var competitionId = Competitions.insert(newCompetition);
      var competition = Competitions.findOne({ _id: competitionId });
      assert(competition);

      var registrationByWcaJsonId = {};
      var uniqueNames = {};
      wcaCompetition.persons.forEach(function(wcaPerson, i) {
        // Pick a uniqueName for this competitor
        var suffix = 0;
        var uniqueName;
        var uniqueNameTaken; // grrr...jshint
        do {
          suffix++;
          uniqueName = wcaPerson.name;
          if(suffix > 1) {
            uniqueName += " " + suffix;
          }
          uniqueNameTaken = !!uniqueNames[uniqueName];
        } while(uniqueNameTaken);
        assert(!uniqueNames[uniqueName]);
        uniqueNames[uniqueName] = true;

        var dobMoment = moment.utc(wcaPerson.dob);
        var registrationId = Registrations.insert({
          competitionId: competition._id,
          uniqueName: uniqueName,
          wcaId: wcaPerson.wcaId,
          countryId: wcaPerson.countryId,
          gender: wcaPerson.gender,
          dob: dobMoment.toDate(),
          registeredEvents: [],
          checkedInEvents: [],
        });
        var registration = Registrations.findOne({ _id: registrationId });

        assert(!registrationByWcaJsonId[wcaPerson.id]);
        registrationByWcaJsonId[wcaPerson.id] = registration;
      });

      // Add data for rounds, results, and groups
      wcaCompetition.events.forEach(function(wcaEvent) {
        log.l0("adding data for " + wcaEvent.eventId);
        // Sort rounds according to the order in which they must have occurred.
        wcaEvent.rounds.sort(function(r1, r2) {
          return ( wca.roundByCode[r1.roundId].supportedRoundIndex -
                   wca.roundByCode[r2.roundId].supportedRoundIndex );
        });
        var newRoundIds = [];
        wcaEvent.rounds.forEach(function(wcaRound, nthRound) {
          var roundInfo = wca.roundByCode[wcaRound.roundId];
          var roundId = Rounds.insert({
            nthRound: nthRound + 1,
            competitionId: competition._id,
            eventCode: wcaEvent.eventId,
            roundCode: wcaRound.roundId,
            formatCode: wcaRound.formatId,
            status: wca.roundStatuses.closed,
          });
          newRoundIds.push(roundId);

          wcaRound.results.forEach(function(wcaResult) {
            // wcaResult.personId refers to the personId in the wca json
            var registration = registrationByWcaJsonId[wcaResult.personId];
            registration.registeredEvents[wcaEvent.eventId] = true;
            registration.checkedInEvents[wcaEvent.eventId] = true;

            var solves = _.map(wcaResult.results, function(wcaValue) {
              return wca.valueToSolveTime(wcaValue, wcaEvent.eventId);
            });
            var id = Results.insert({
              competitionId: competition._id,
              roundId: roundId,
              registrationId: registration._id,
              uniqueName: registration.uniqueName,
              position: wcaResult.position,
              solves: solves,
              best: wca.valueToSolveTime(wcaResult.best, wcaEvent.eventId),
              average: wca.valueToSolveTime(wcaResult.average, wcaEvent.eventId),
            }, {
              // meteor-collection2 is *killing* us here when we are inserting
              // a bunch of stuff at once. Turning off all the validation it
              // does for us gives a huge speed boost.
              validate: false,
              filter: false,
              autoConvert: false,
              removeEmptyStrings: false,
              getAutoValues: false,
            });
          });

          wcaRound.groups.forEach(function(wcaGroup) {
            Groups.insert({
              competitionId: competition._id,
              roundId: roundId,
              group: wcaGroup.group,
              scrambles: wcaGroup.scrambles,
              extraScrambles: wcaGroup.extraScrambles,
              scrambleProgram: wcaCompetition.scrambleProgram
            });
          });
        });

        newRoundIds.forEach(function(roundId) {
          Meteor.call('recomputeWhoAdvanced', roundId);
        });

        log.l0("finished adding data for " + wcaEvent.eventId);
      });

      // Update the registrations to reflect the events they signed up for
      // and checked in for.
      for(var jsonId in registrationByWcaJsonId) {
        if(registrationByWcaJsonId.hasOwnProperty(jsonId)) {
          var registration = registrationByWcaJsonId[jsonId];
          var registrationId = Registrations.update({
            _id: registration._id,
          }, {
            $set: {
              registeredEvents: _.keys(registration.registeredEvents),
              checkedInEvents: _.keys(registration.checkedInEvents),
            }
          });
        }
      }

      return competition.wcaCompetitionId || competition._id;
    },
    recomputeWhoAdvanced: function(roundId) {
      check(roundId, String);

      var round = Rounds.findOne({ _id: roundId });
      var nextRound = Rounds.findOne({
        competitionId: round.competitionId,
        eventCode: round.eventCode,
        nthRound: round.nthRound + 1,
      }, {
        fields: {
          size: 1,
        }
      });

      var results = Results.find({
        roundId: roundId,
      }, {
        fields: {
          _id: 1,
          userId: 1,
        }
      });

      results.forEach(function(result) {
        var advanced;
        if(nextRound) {
          // If the userId for this result is present in the next round,
          // then they advanced!
          advanced = !!Results.findOne({
            roundId: nextRound._id,
            userId: result.userId
          });
        } else {
          // If there is no next round, then this result cannot possibly have
          // advanced.
          advanced = false;
        }
        Results.update({
          _id: result._id,
        }, {
          $set: {
            advanced: advanced,
          }
        });
      });
    },
  });
}
