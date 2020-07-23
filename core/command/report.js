var path = require('path');
var chalk = require('chalk');
var cloneDeep = require('lodash/cloneDeep');

var allSettled = require('../util/allSettled');
var fs = require('../util/fs');
var logger = require('../util/logger')('report');
var compare = require('../util/compare/');
let ReportPortalClient = require('@reportportal/client-javascript');

function writeReport (config, reporter) {
  var promises = [];

  if (config.report && config.report.indexOf('CI') > -1 && config.ciReport.format === 'junit') {
    promises.push(writeJunitReport(config, reporter));
  }

  if (config.report && config.report.indexOf('json') > -1) {
    promises.push(writeJsonReport(config, reporter));
  }

  if (config.report && config.report.indexOf('ReportPortal') > -1) {
    promises.push(writeReportPortalReport(config, reporter));
  }

  promises.push(writeBrowserReport(config, reporter));

  return allSettled(promises);
}

function writeBrowserReport (config, reporter) {
  var testConfig;
  if (typeof config.args.config === 'object') {
    testConfig = config.args.config;
  } else {
    testConfig = Object.assign({}, require(config.backstopConfigFileName));
  }

  var browserReporter = cloneDeep(reporter);
  function toAbsolute (p) {
    return (path.isAbsolute(p)) ? p : path.join(config.projectPath, p);
  }
  logger.log('Writing browser report');

  return fs.copy(config.comparePath, toAbsolute(config.html_report)).then(function () {
    logger.log('Resources copied');

    // Fixing URLs in the configuration
    var report = toAbsolute(config.html_report);
    for (var i in browserReporter.tests) {
      if (browserReporter.tests.hasOwnProperty(i)) {
        var pair = browserReporter.tests[i].pair;
        pair.reference = path.relative(report, toAbsolute(pair.reference));
        pair.test = path.relative(report, toAbsolute(pair.test));

        if (pair.diffImage) {
          pair.diffImage = path.relative(report, toAbsolute(pair.diffImage));
        }
      }
    }

    var reportConfigFilename = toAbsolute(config.compareConfigFileName);
    var testReportJsonName = toAbsolute(config.bitmaps_test + '/' + config.screenshotDateTime + '/report.json');

    // if this is a dynamic test then we assume browserReporter has one scenario. This scenario will be appended to any existing report.
    if (testConfig.dynamicTestId) {
      try {
        console.log('Attempting to open: ', testReportJsonName);
        var testReportJson = require(testReportJsonName);
        testReportJson.tests = testReportJson.tests.filter(test => test.pair.fileName !== browserReporter.tests[0].pair.fileName);
        testReportJson.tests.push(browserReporter.tests[0]);
        browserReporter = testReportJson;
      } catch (err) {
        console.log('Creating new report.');
      }
    }

    var jsonReport = JSON.stringify(browserReporter, null, 2);
    var jsonpReport = `report(${jsonReport});`;

    var jsonConfgWrite = fs.writeFile(testReportJsonName, jsonReport).then(function () {
      logger.log('Copied json report to: ' + testReportJsonName);
    }, function (err) {
      logger.error('Failed json report copy to: ' + testReportJsonName);
      throw err;
    });

    var jsonpConfgWrite = fs.writeFile(toAbsolute(reportConfigFilename), jsonpReport).then(function () {
      logger.log('Copied jsonp report to: ' + reportConfigFilename);
    }, function (err) {
      logger.error('Failed jsonp report copy to: ' + reportConfigFilename);
      throw err;
    });

    return allSettled([jsonpConfgWrite, jsonConfgWrite]);
  }).then(function () {
    if (config.openReport && config.report && config.report.indexOf('browser') > -1) {
      var executeCommand = require('./index');
      return executeCommand('_openReport', config);
    }
  });
}

function writeJunitReport (config, reporter) {
  logger.log('Writing jUnit Report');

  var builder = require('junit-report-builder');
  var suite = builder.testSuite()
    .name(reporter.testSuite);

  for (var i in reporter.tests) {
    if (!reporter.tests.hasOwnProperty(i)) {
      continue;
    }

    var test = reporter.tests[i];
    var testCase = suite.testCase()
      .className(test.pair.selector)
      .name(' ›› ' + test.pair.label);

    if (!test.passed()) {
      var error = 'Design deviation ›› ' + test.pair.label + ' (' + test.pair.selector + ') component';
      testCase.failure(error);
      testCase.error(error);
    }
  }

  return new Promise(function (resolve, reject) {
    var testReportFilename = config.testReportFileName || config.ciReport.testReportFileName;
    testReportFilename = testReportFilename.replace(/\.xml$/, '') + '.xml';
    var destination = path.join(config.ci_report, testReportFilename);

    try {
      builder.writeTo(destination);
      logger.success('jUnit report written to: ' + destination);

      resolve();
    } catch (e) {
      return reject(e);
    }
  });
}

function writeJsonReport (config, reporter) {
  var jsonReporter = cloneDeep(reporter);
  function toAbsolute (p) {
    return (path.isAbsolute(p)) ? p : path.join(config.projectPath, p);
  }
  logger.log('Writing json report');
  return fs.ensureDir(toAbsolute(config.json_report)).then(function () {
    logger.log('Resources copied');

    // Fixing URLs in the configuration
    var report = toAbsolute(config.json_report);
    for (var i in jsonReporter.tests) {
      if (jsonReporter.tests.hasOwnProperty(i)) {
        var pair = jsonReporter.tests[i].pair;
        pair.reference = path.relative(report, toAbsolute(pair.reference));
        pair.test = path.relative(report, toAbsolute(pair.test));

        if (pair.diffImage) {
          pair.diffImage = path.relative(report, toAbsolute(pair.diffImage));
        }
      }
    }

    return fs.writeFile(toAbsolute(config.compareJsonFileName), JSON.stringify(jsonReporter.getReport(), null, 2)).then(function () {
      logger.log('Wrote Json report to: ' + toAbsolute(config.compareJsonFileName));
    }, function (err) {
      logger.error('Failed writing Json report to: ' + toAbsolute(config.compareJsonFileName));
      throw err;
    });
  });
}

function validateReportPortalConfig (reportPortalConfig) {
  if (!reportPortalConfig) {
    throw new Error('The "reportPortalConfig" is missing.');
  }
  if (!reportPortalConfig.token) {
    throw new Error('ReportPortal - token is missing.');
  }
  if (!reportPortalConfig.endpoint) {
    throw new Error('ReportPortal - endpoint is missing.');
  }
  if (!reportPortalConfig.launch) {
    throw new Error('ReportPortal - launch is missing.');
  }
  if (!reportPortalConfig.project) {
    throw new Error('ReportPortal - project is missing.');
  }
  return reportPortalConfig;
}

function convertValueToLogableString (rawValue) {
  if (rawValue === undefined) {
    return '{undefined}'
  }
  if (rawValue === null) {
    return '{null}'
  }
  return rawValue
}

function convertToReportPortalStatus (backstopjsstatus) {
  if (backstopjsstatus === 'fail') {
    return 'FAILED';
  }
  if (backstopjsstatus === 'running') {
    return 'INTERRUPTED';
  }
  if (backstopjsstatus === 'pass') {
    return 'PASSED';
  }
  throw new Error(`Unknown status: '${backstopjsstatus}'.`);
}

function writeReportPortalReport (config, reporter) {
  function toAbsolute (p) {
    return (path.isAbsolute(p)) ? p : path.join(config.projectPath, p);
  }

  logger.log('Submitting ReportPortal report');
  if (!reporter.tests || reporter.tests.length == 0) {
    logger.log('No tests to submit.');
    return Promise.resolve();
  }

  const reportPortalConfig = validateReportPortalConfig(config.reportPortalOptions);

  const reportPortalClient = new ReportPortalClient(reportPortalConfig);

  /*
  return reportPortalClient.checkConnect().then((response) => {
    console.log('You have successfully connected to the server.');
    console.log(`You are using an account: ${response.fullName}`);
  }, (error) => {
    console.log('Error connection to server');
    console.dir(error);
  });
  */
  const launchObject = reportPortalClient.startLaunch({
    // name: "Client test",
    // startTime: rpClient.helpers.now(),
    // description: "description of the launch",
    /*
    attributes: [
        {
            "key": "yourKey",
            "value": "yourValue"
        },
        {
            "value": "yourValue"
        }
    ],
    */
    // this param used only when you need client to send data into the existing launch
    // id: 'id'
  });

  const suiteName = reporter.testSuite;
  const suiteObject = reportPortalClient.startTestItem({
    name: suiteName,
    type: 'SUITE'
  }, launchObject.tempId);
  const testClassObject = reportPortalClient.startTestItem({
    name: 'TestClass',
    description: 'In C# this objects are the test classes. Still need to figure out what\'s the purpose here.',
    type: 'TEST'
  }, launchObject.tempId, suiteObject.tempId);

  reporter.tests.forEach(test => {
    const testPair = test.pair;
    const testName = `${testPair.label}-${testPair.viewportLabel}`;
    const testDescription = `Comparing at URL: ${testPair.url}`;
    const status = convertToReportPortalStatus(test.status);

    const testObject = reportPortalClient.startTestItem({
      name: testName,
      description: testDescription,
      type: 'STEP',
      attributes: [{ key: 'viewportLabel', value: testPair.viewportLabel }]
    }, launchObject.tempId, testClassObject.tempId);

    const selector = convertValueToLogableString(testPair.selector);
    const url = convertValueToLogableString(testPair.url);
    reportPortalClient.sendLog(testObject.tempId, {
      level: 'INFO',
      message: `Comparing image for selector '${selector}' on url '${url}' with a threshold of '${testPair.misMatchThreshold}%'.`
    });

    if (testPair.diff) {
      const diff = testPair.diff;
      if (!diff.isSameDimensions && diff.dimensionDifference) {
        const dimensionDifference = diff.dimensionDifference;
        reportPortalClient.sendLog(testObject.tempId, {
          level: 'WARN',
          message: `Compared image has different dimension by: height: '${dimensionDifference.height}', width: '${dimensionDifference.width}'.`
        });
      }
      if (diff.misMatchPercentage) {
        reportPortalClient.sendLog(testObject.tempId, {
          level: 'INFO',
          message: `Compared image has a mismatch of '${diff.misMatchPercentage}%'.`
        });
      }
    }

    if (testPair.engineErrorMsg) {
      reportPortalClient.sendLog(testObject.tempId, {
        level: 'ERROR',
        message: `engineErrorMsg: '${testPair.engineErrorMsg}'`
      });
    }

    if (testPair.error) {
      reportPortalClient.sendLog(testObject.tempId, {
        level: 'ERROR',
        message: testPair.error
      });
    }
    if (testPair.diffImage) {
      const diffImageAbsolutePath = toAbsolute(testPair.diffImage);
      logger.log(`Uploading diff image:${testPair.diffImage} gaxi ${diffImageAbsolutePath}.`);
      const fsObject = fs.readFileSync(diffImageAbsolutePath);
      const contentBase64 = Buffer.from(fsObject).toString('base64');
      const fileExtension = path.extname(diffImageAbsolutePath).replace('.', '');
      const fileObject = {
        name: path.basename(diffImageAbsolutePath),
        type: `image/${fileExtension}`,
        content: contentBase64,
      };
      var sendLogObject = reportPortalClient.sendLog(
        testObject.tempId,
        {
          level: 'ERROR',
          message: 'Difference found'
        },
        fileObject);
    }

    const finishTestObject = reportPortalClient.finishTestItem(testObject.tempId, {
      status: status
    });
  });

  const finishTestClassObject = reportPortalClient.finishTestItem(testClassObject.tempId, { });

  const finishSuiteObject = reportPortalClient.finishTestItem(suiteObject.tempId);

  const finishObject = reportPortalClient.finishLaunch(launchObject.tempId, { });

  return reportPortalClient.getPromiseFinishAllItems(launchObject.tempId).then(() => {
    return Promise.resolve();
  });
}

module.exports = {
  execute: function (config) {
    return compare(config).then(function (report) {
      var failed = report.failed();
      logger.log('Test completed...');
      logger.log(chalk.green(report.passed() + ' Passed'));
      logger.log(chalk[(failed ? 'red' : 'green')](+failed + ' Failed'));

      return writeReport(config, report).then(function (results) {
        for (var i = 0; i < results.length; i++) {
          if (results[i].state !== 'fulfilled') {
            logger.error('Failed writing report with error: ' + results[i].value);
          }
        }

        if (failed) {
          logger.error('*** Mismatch errors found ***');
          // logger.log('For a detailed report run `backstop openReport`\n');
          throw new Error('Mismatch errors found.');
        }
      });
    }, function (e) {
      logger.error('Comparison failed with error:' + e);
    });
  }
};
