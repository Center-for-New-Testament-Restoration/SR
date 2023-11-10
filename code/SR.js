/*******************************************************************************
Statistical Restoration Greek New Testament
Copyright © 2022 Alan Bunning.
Released under the GNU General Public License 3.0 (GPLv3)
https://www.gnu.org/licenses
*******************************************************************************/
"use strict";

// external modules
const mysqldb = require("#mysqldb"), db = new mysqldb.database;
const essence = require("#greek").essence;
const loadJSON = require("#file").loadJSON;
const writeFile = require("#file").writeFile, fs = new writeFile;

// options
const compare = "0G4BHP";      // "0G4BHP", "0G2NA", etc.
const assistable = true;       // modern critical texts can be included in the decision if only two early witnesses are involved that disagree
const overridable = true;      // unanimous agreement of critical texts can override the selected reading
const historical = false;      // historical passages can be included that were not selected (don't use with outputCompare)
const output = outputCompare;  // function for displaying output (outputData, outputText, outputCompare, outputStats)

// main program
void async function() {
  var verses=[];
  await db.open();
  await initialize();

  // process list of verses
  verses = await db.SQL("SELECT DISTINCT VerseID FROM verse WHERE VerseID LIKE '" + arg[0] + "%'");
  if (output == outputStats) await calibrate(verses);
  else for (let i in verses) await processVerse(verses[i].VerseID+"");

  // show summary if outputCompare option chosen
  if (output == outputCompare) console.log("Insertions:",insertions,"Deletions:",deletions,"Overrides:",overrides,"Assists:",assists);

  await db.close();
  }();

// initialize global variables
async function initialize() {
  var list=[], minDate=9999, maxDate=0;


  // get paramater (bb[ccc[vvv]] or % for all)
  global.arg = process.argv.slice(2);
  if (arg.length == 0) {console.log("no parameter specified"); process.exit();}

  // load data structures
  global.xcollation = loadJSON("xcollation.json");
  global.xmatrix = loadJSON("xmatrix.json");
  global.xapparatus = loadJSON("xapparatus.json");

  // weighing values
  global.weight = {reliability : 1.22, earliness : 1.00, support : 0.70};  // weight of the components
  global.power  = {reliability : 9.08, earliness : 1.16, support : 0.16};  // sensitivity of the components

  // statistics
  global.insertions = 0;  // number of insertions to compared text
  global.deletions = 0;   // number of deletions to compared text
  global.overrides = 0;   // number of overrides
  global.assists = 0;     // number of assists

  global.book = 0;        // book of Bible (used by support)
  global.order = 0;       // order of words for output

  // load date
  global.score = [];
  list = await db.SQL("SELECT WritingID,Hand,Reliability,Date1,Date2 FROM witness");
  for (let i = 0; i < list.length; i++) {
    if (list[i].WritingID[0] == "0") continue;  // don't include critical texts
    minDate = Math.min((list[i].Date1 + list[i].Date2)/2,minDate);  // faster than doing a separate query
    maxDate = Math.max((list[i].Date1 + list[i].Date2)/2,maxDate);
    }

  // load reliability
  for (let i = 0; i < list.length; i++)
    score[list[i].WritingID + list[i].Hand.replace(/\^/,"")] = {
      reliability:list[i].Reliability,
      earliness:(list[i].WritingID[0] == "0" ? 0 : 1 - (((list[i].Date1 + list[i].Date2) / 2) - minDate) / (maxDate - minDate) )};  // average of date range

  // load affinity
  global.diversity = [];
  list = await db.SQL("SELECT * FROM affinity WHERE Witness1 NOT LIKE '0%' AND Witness2 NOT LIKE '0%'");
  list.forEach(e => diversity[e.Witness1 + "," + e.Witness2 + "," + e.BookID] = 1 - e.Affinity);  // opposite of affinity

  // converts collationIDs into running page/column/line/word format
  global.pclw = (function(ID) {
    var page=0, line=0, word=0, chapter=0, verse=0;
    function pclw(ID) {
      if (chapter != Math.floor(ID / 1000000)) {
        page++;
        line = word = 0;
        }
      if (verse != Math.floor(ID / 1000)) {
        line++;
        word = 0;
        }
      word++;

      chapter = Math.floor(ID / 1000000);
      verse = Math.floor(ID / 1000);
      return page * 1000000 + line * 100 + word;
      }
    return pclw;
    })();
  }

// process each verse in each chapter
function processVerse(bcv) {
  var collation=xcollation[bcv], matrix=xmatrix[bcv], apparatus=xapparatus[bcv], negatives=[];
  book = Math.floor(bcv/1000000);

  // process each text segment of the verse
  for (let segment of apparatus) {
    var unit, weightExternal=[], summary=0, assisted=null, overrided=null, brackets="", winner, reading=[], probabilities=[];

    // segment with no variants
    if (segment.variant == null)
      output(collation,matrix,segment.start,segment.end,segment.unit[0].reading,100,"");

    // segment with summary record evaluate whole verse using external weight only
    else if (segment.variant == "#") {
      unit = prune(segment.unit,negatives);  // remove unnecessary readings and witnesses from variant unit
      unit = removeCT(unit);  // remove critical texts

      // weigh the external evidence to decide if verse should be included or not
      weightExternal = weighExternal(unit);
      for (let i in unit) if (weightExternal[i] > weightExternal[summary]) summary = i;

      // if verse should be excluded, supply the historical wording in double brackets if appropriate
      if (unit[summary].reading == "-") {
        if (historical) output(collation,matrix,1,collation.length-1,collation.filter(e => e.Historical == "H").map(e => e.CollationID),0,"[[");
        else output(collation,matrix,1,collation.length-1,"",0,"[[");  // empty verse, historical words not supplied
        break;  // don't process any other units in the verse
        }

      // get list of all negative early witnesses, so that they don't influence the decision
      else for (let i in unit) if (unit[i].reading == "-") {negatives = unit[i].witnesses; break;}
      }

    // segment with variant readings
    else {
      unit = prune(segment.unit,negatives);  // remove unnecessary readings and witnesses from variant unit
      if (assistable) assisted = expertAssist(unit,collation);
      if (overridable) overrided = expertOverride(unit);
      unit = removeCT(unit);  // remove critical texts
      unit = exclude(unit,collation,segment.unit);  // exclude readings by textual criticism rules 

      [winner, probabilities] = weigh(unit,collation);  // determine the winner

      // designate alternative readings in brackets (displayed in outputCompare)
      if (overrided != null && overrided != winner && (assisted == null || overrided != assisted)) {  // it was overrided, and assisted didn't get it either
        winner = overrided;
        overrides++;
        brackets = "[";
        }
      else if (assisted != null && assisted != winner) {  // it was not overrided, but it was assisted 
        winner = assisted;
        assists++;
        brackets = "{";
        }
      else brackets = "<";

      // load winning reading
      reading = segment.unit[winner].reading;  // uses segment.unit because expert override could select a reading without early support
      if (historical && ! reading.length) reading = collation.slice(segment.start,segment.end+1).filter(e => e.Historical == "H").map(e => e.CollationID);

      // record probabilities for each reading in the unit
      for (let i in segment.unit) segment.unit[i].probability = (probabilities[i] * 100 || 100);

      output(collation,matrix,segment.start,segment.end,reading,segment.unit[winner].probability,brackets);
      }
    }
  }

// exclude readings by textual critical rules (only one example for now)
function exclude(unit,collation,preunit) {
  var conflation, max=0;

  // exclude singular conflation
  for (let i in preunit) if (preunit[i].reading.length > max) [conflation, max] = [i, preunit[i].reading.length];  // determine longest reading before unit is altered
  if (max && unit[conflation] && unit[conflation].witnesses.length == 1 && (collation[unit[conflation].reading[0] % 1000 - collation[0].CollationID % 1000].VariantType || "").toLowerCase() == "c") delete unit[conflation];

  return unit;
  }

// return reading if the situation is assistable (only two opposing early witnesses)
function expertAssist(unit,collation) {
  var early=[], witnesses={}, winner;

  // determine if the reading needs assistance
  for (let i in unit) {
    early = unit[i].witnesses.filter(witness => (! /^0/.test(witness)));
    if (early.length > 1) return null;  // more than one early witness supports a reading so assist not needed
    if (early.length == 1) witnesses[early[0].replace(/\*/,"")] = true;  // original hand does not get two votes if there is a correction
    }
  if (Object.keys(witnesses).length > 2) return null;  // more than two different early readings so assist is not needed

  [winner] = weigh(unit,collation);
  return winner;
  }

// return reading if there is unanimous agreement of the critical texts
function expertOverride(unit) {
  var reading, experts=0;

  // count the number of readings that have a critical text witness
  for (let i in unit)
    for (let witness of unit[i].witnesses)
      if (/^0/.test(witness)) {experts++; reading = i; break;}  // only breaks out of inner loop

  // check if the critical texts only support one reading
  if (experts == 1) return reading;
  else return null;
  }

// remove unnecessary witnesses from the variant unit and return whether it needs expert assistance
function prune(unit, negatives) {
  unit = JSON.parse(JSON.stringify(unit));  // make a copy so that apparatus remains unchange for subsequent runs

  for (let i in unit) {
    for (let j = unit[i].witnesses.length - 1; j >= 0; j--) {
      unit[i].witnesses[j] = unit[i].witnesses[j].replace(/[\+\-]/,"");  // remove vid markings
      if (unit[i].witnesses[j] == "0G0SR" || unit[i].witnesses[j] == "0G4BHP") unit[i].witnesses.splice(j,1);  // delete CNTR created texts
      if (negatives && negatives.includes(unit[i].witnesses[j])) unit[i].witnesses.splice(j,1);  // remove negative early witness
      }

    for (let j = unit[i].witnesses.length - 1; j >= 0; j--)
      if (unit[i].witnesses.includes(unit[i].witnesses[j].slice(0,-1))) unit[i].witnesses.splice(j,1); // delete other hands if reading is the same (has to come after vid removed)

    if (unit[i] && ! unit[i].witnesses.length) delete unit[i];  // delete reading if no witnesses are left (leaves empty entry in place)
    }
  return unit;
  }

// remove critical texts from the variant unit
function removeCT(unit) {
  for (let i in unit) {
    for (let j = unit[i].witnesses.length - 1; j >= 0; j--)
      if (/^0/.test(unit[i].witnesses[j])) unit[i].witnesses.splice(j,1);  // delete critical text witness from reading
    if (unit[i] && ! unit[i].witnesses.length) delete unit[i];  // delete reading if no witnesses are left (leaves empty entry in place)
    }
  return unit;
  }

// weigh the unit based on external and internal evidence
function weigh(unit,collation) {
  var weightExternal=[], weightInternal=[], winner=0;

  weightExternal = weighExternal(unit);
  weightInternal = weighInternal(unit,collation);

  // eliminate readings that only have critical texts so that they are not chosen (used for expert assist)
  for (let i in unit) if (! unit[i].witnesses.find(e => /^[^0]/.test(e))) delete unit[i];

  // find the winner
  for (let i in unit) if (weightInternal[i] > weightInternal[winner]) winner = i;

  // ties are broken by the external evidence
  for (let i in unit) if (weightInternal[i] == weightInternal[winner] && weightExternal[i] > weightExternal[winner]) winner = i;

  return [winner, weightInternal];
  }

// weigh the external evidence for the variant unit
function weighExternal(unit) {
  var value=new Array(unit.length).fill(0), total=0, reliability=[], earliness=[], support=[];

  reliability = weighReliability(unit);
  earliness = weighEarliness(unit);
  support = weighSupport(unit);

  // calculate values for each witness and total each category
  for (let i in unit) {
    value[i] = (reliability[i] * weight.reliability) + (earliness[i] * weight.earliness) + (support[i] * weight.support);
    total += value[i];
    }

  // scale all of the scores to a percentage
  for (let i in value) value[i] /= total;
  return value;
  }

// determine reliability percentages across all readings of a variant unit
function weighReliability(unit) {
  var value=new Array(unit.length).fill(0), total=0;

  // collect reliability stats for each reading
  for (let i in unit) {
    for (let witness of unit[i].witnesses) {
      if (! /\*/.test(witness)) value[i] += Math.pow(score[witness.replace(/[*]/g,"")].reliability,power.reliability); // skip over uncorrected original hand (uncorrected hand is not in unit if same as corrected hand)
      }
    total += value[i];
    }

  // scale all of the scores to a percentage
  for (let i in value) value[i] /= total;
  return value;
  }

// determine earliness percentages across all readings of a variant unit
function weighEarliness(unit) {
  var value=new Array(unit.length).fill(0), total=0;

  // collect earliness stats for each reading
  for (let i in unit) {
    for (let witness of unit[i].witnesses)
      value[i] += Math.pow(score[witness.replace(/[*]/g,"")].earliness,power.earliness);
    total += value[i];
    }

  // scale all of the scores to a percentage
  for (let i in value) value[i] /= total;
  return value;
  }

// determine diversity of support percentages across all readings of a variant unit
function weighSupport(unit) {
  var value=new Array(unit.length).fill(0), maxdiversity=new Array(unit.length).fill(0), minaffinity=new Array(unit.length).fill(9999), total=0, min, witnesses=[], weight;
//console.log(unit);

  // create array of witnesses
  for (let i in unit)
     for (let witness of unit[i].witnesses) witnesses.push({witness : witness, reading : i});
  witnesses.sort((a, b) => (a.witness > b.witness) ? 1 : -1)
//console.log(witnesses);

  // find diversity between each set of witnesses
  for (let i = 0; i < witnesses.length; i++) {
    for (let j = i + 1; j < witnesses.length; j++) {
      weight = Math.pow((diversity[witnesses[i].witness.replace(/[*]/g,"") + "," + witnesses[j].witness.replace(/[*]/g,"") + "," + book] || 0),power.support);
      if (witnesses[i].reading == witnesses[j].reading) maxdiversity[witnesses[i].reading] = Math.max(maxdiversity[witnesses[i].reading],weight);
      else {
        minaffinity[witnesses[i].reading] = Math.min(minaffinity[witnesses[i].reading],weight);
        minaffinity[witnesses[j].reading] = Math.min(minaffinity[witnesses[j].reading],weight);
        }
      }
    }

  // collect support stats for each reading
  for (let i in unit) {
    value[i] = maxdiversity[i] + (1 - minaffinity[i]); 
    total += value[i];
    }

  // scale all of the scores to a percentage
  for (let i in value) value[i] /= total;
  return value;
  }

// weigh each word of variant unit by external evidence
function weighInternal(unit,collation) {
  var value=new Array(unit.length).fill(0), IDs=[], lookup={}, slots={}, slotUnit=[], weightExternal=[], pos, wordID, word, total=0;
//console.log(unit);

  // get list of collation ID's used in the readings
  for (let i in unit) if (unit[i].reading) IDs = IDs.concat(unit[i].reading);

  IDs = [...new Set(IDs)].sort();

  // make lookup table to map each collationID to a "slot"
  for (let ID of IDs) {
    pos = ID % 1000 - collation[0].CollationID % 1000;  // adjust for summary record if needed
    if (! collation[pos].Incomplete) continue;  // skip slots in variant unit that don't have any variant words (transposition)
    lookup[ID] = collation[pos].Align || ID;  // a slot is represented by its alignment value or its collationID
    slots[lookup[ID]] = {};  // add entry to the slots array (multiples can occupy same slot in case of transposition)
    }

  // evalute the words in each slot
  for (let slot in slots) {

    // create unit with array of witnesses for each word in each slot (including entry for no word)
    for (let i in unit) {
      if (! unit[i].reading.length) {
        slots[slot]["#"] = {reading : ["#"], witnesses : unit[i].witnesses};
        continue;
        }
      wordID = "";
      for (let ID of unit[i].reading) // go through each word of the reading and see if it matches the slot
        if (lookup[ID] == slot) {wordID = ID; break;}
      word = (wordID ? collation[wordID % 1000 - collation[0].CollationID % 1000].Classic : "");

      // add the word and witnesses to the slot
      if (slots[slot][word]) slots[slot][word] = {reading : (slots[slot][word].reading.includes(wordID) ? slots[slot][word].reading : slots[slot][word].reading.concat([wordID])), witnesses : slots[slot][word].witnesses.concat(unit[i].witnesses)};
      else slots[slot][word] = {reading : [wordID], witnesses : unit[i].witnesses};
      }

    // create separate unit for each slot
    slotUnit = [];
    for (let word in slots[slot]) slotUnit.push(slots[slot][word]);  // create a unit for the word choices in slot

    // find the external weight of the words in each slot
    weightExternal = weighExternal(slotUnit);  // find external weight for each choice in the slot (i.e. "", word1, word2)

    // grade each variant unit reading by the weight of the word (or no word) that it contains in this slot
    for (let i in unit) {
      wordID = (unit[i].reading.length ? "" : "#");  // distinguishes between missing word or empty reading
      for (let ID of unit[i].reading) if (lookup[ID] == slot) {wordID = ID; break;} // find ID in reading that belongs to this slot
      for (let j in slotUnit)
        if (slotUnit[j].reading.includes(wordID) || slotUnit[j].reading == wordID) {value[i] += weightExternal[j]; break;}  // the empty reading in the latter condition
      }
    }

  // scale all of the scores to a percentage
  for (let i in value) total += value[i];
  for (let i in value) value[i] /= total;

  return value;
  }

// output text format
function outputText(collation,matrix,start,end,reading,probability,brackets) {
  var pos;
  if (start == 1 - collation[0].CollationID % 1000) process.stdout.write(Math.floor(collation[0].CollationID / 1000)+"");
  if (brackets == "<" || brackets == "[[" || brackets == "{") brackets = "";  // only showing [ for now
  for (let ID of reading) {
    process.stdout.write(" ");
    if (ID == reading[0]) process.stdout.write(brackets);  // open bracket if non-zero length
    pos = ID % 1000 - collation[0].CollationID % 1000;
    process.stdout.write(dress(collation[pos].Medieval,collation[pos].Capitalization,collation[pos].Punctuation,collation[pos].Koine));
    }
  if (reading.length) process.stdout.write(brackets.replace(/[\[\{<]/g,m => {return {"[":"]", "{":"}", "<":">"}[m]}));  // close bracket if non-zero length
  if (end == collation.length - 1) process.stdout.write("\n");  // always need to reach this even if it is empty
  }

// output compare format
function outputCompare(collation,matrix,start,end,reading,probability,brackets) {
  var words=[], comp;
  if (brackets == "[[") {process.stdout.write(Math.floor(collation[0].CollationID/1000)+"\n"); return;}  // nothing to compare in historical passages that are excluded
  if (start == 1 - collation[0].CollationID % 1000) process.stdout.write(Math.floor(collation[0].CollationID/1000)+"");
  process.stdout.write(" " + brackets);

  for (let i = start; i <= end; i++) {  // create array of words for segment
    comp = (matrix[compare] && matrix[compare][i] ? matrix[compare][i] : "");
    if (comp && reading.includes(collation[i].CollationID)) words.push(dress(collation[i].Medieval,collation[i].Capitalization,collation[i].Punctuation,collation[i].Koine));
    else if (comp && ! reading.includes(collation[i].CollationID)) {deletions++; words.push("-" + dress(collation[i].Medieval,collation[i].Capitalization,collation[i].Punctuation,collation[i].Koine));}
    else if (! comp && reading.includes(collation[i].CollationID)) {insertions++; words.push("+" + dress(collation[i].Medieval,collation[i].Capitalization,collation[i].Punctuation,collation[i].Koine));}
    }

  process.stdout.write(words.join(" "));
  process.stdout.write(brackets.replace(/[\[\{<]/g,m => {return {"[":"]", "{":"}", "<":">"}[m]}));
  if (brackets) process.stdout.write(probability.toFixed(2));
  if (end == collation.length - 1) process.stdout.write("\n");
  }

// output statistics only
function outputStats(collation,matrix,start,end,reading,probability,brackets) {
  var comp;
  if (brackets == "[[") return;
  for (let i = start; i <= end; i++) {
    if (! historical && collation[i].BHP && collation[i].BHP.includes("-")) continue;  // skip over words in historical passage
    comp = (matrix[compare] && matrix[compare][i] ? matrix[compare][i] : "");
    if (comp && ! reading.includes(collation[i].CollationID)) deletions++;
    else if (! comp && reading.includes(collation[i].CollationID)) insertions++;
    }
  }

// output data format
function outputData(collation,matrix,start,end,reading,probability,brackets) {
  var pos;
  if (brackets == "[[" && start == 1 && ! historical) {
    order += 10;
    process.stdout.write("0G0SR" + "\t" + order + "\t" + pclw(collation[0].CollationID) + "\t\t\t" + collation[0].CollationID + "\t-\t\t\n");
    }
  if (! reading.length) return;
  if (brackets == "<" || brackets == "[[" || brackets == "{") brackets = "";  // but keep single brackets
  for (let ID of reading) {
    order += 10;
    process.stdout.write("0G0SR" + "\t" + order + "\t" + pclw(ID) + "\t\t\t" + ID + "\t");
    if (ID == reading[0]) process.stdout.write(brackets);
    pos = ID % 1000 - collation[0].CollationID % 1000;
    process.stdout.write(dress(collation[pos].Medieval,collation[pos].Capitalization,collation[pos].Punctuation,collation[pos].Koine));
    if (ID == reading[reading.length-1]) process.stdout.write(brackets.replace(/[\[\{<]/g,m => {return {"[":"]", "{":"}", "<":">"}[m]}));
    process.stdout.write("\t" + essence(collation[pos].Medieval) + "\t" + Math.trunc(probability) + "\n");
    }
  }

// dress a word with punctuation and capitalization
function dress(word,caps,marks,koine) {
  if (! word) return;
  if (/[A-Z]/.test(caps)) word = word.charAt(0).toUpperCase() + word.substr(1);
  if (koine.charAt(0) == "=") word = "˚" + word;
  if (marks) word = marks.replace(/[^¶\(\[‘“⋄]/g,"") + word + marks.replace(/[¶\(\[‘“⋄]/g,"");  // following marks [^,\:\–·.!;\)\]’”…]
  return word;
  }

// calibrate the text to a compared text
async function calibrate(verses) {
  var test, base, range, increment, min={}, record, minchanges=9999, mininsertions=9999, mindeletions=9999;  // infinity = 9999;

  test = weight;  // or test = power
  range = .05; increment = .01;

  base = {...test};
  for (test.reliability = base.reliability - range; test.reliability < base.reliability + range + .001; test.reliability += increment) {
    for (test.earliness = base.earliness - range; test.earliness < base.earliness + range + .001; test.earliness += increment) {
      for (test.support = base.support - range; test.support < base.support + range + .001; test.support += increment) {
        insertions = deletions = overrides = assists = 0;  // reset counts to 0

        for (let i in verses) await processVerse(verses[i].VerseID+"");

        record = JSON.stringify({
          weightR : weight.reliability, weightE : weight.earliness, weightS : weight.support,
          powerR : power.reliability, powerE : power.earliness, powerS : power.support,
          changes : insertions + deletions, insertions : insertions, deletions : deletions},
          (key, val) => val.toFixed ? Number(val.toFixed(3)) : val);  // converts each numeric field to fixed decimal
        console.log(record);

        if (insertions + deletions < minchanges) {minchanges = insertions + deletions; min.changes = record;}
        if (insertions < mininsertions) {mininsertions = insertions; min.insertions = record;}
        if (deletions  < mindeletions)  {mindeletions  = deletions;  min.deletions  = record;}
        }
      }
    }
  console.log("min changes   ",min.changes);
  console.log("min insertions",min.insertions);
  console.log("min deletions ",min.deletions);
  }
