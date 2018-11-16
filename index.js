var request = require('request-promise')
var RateLimiter = require('request-rate-limiter');

/*
 * checks that a string is a valid hex color code without the preceding `#`
 */
var valid_color = /^([0-9A-F]{3}$|[0-9A-F]{6}$)/i

/*
 * GitHub api requires a `User-Agent` header.
 * Managing label descriptions via API is in beta. Requires the following Accept header.
 */
var header = { 
  'User-Agent': 'org-labels',
  'Accept': 'application/vnd.github.symmetra-preview+json'
}

/*
 * expose `Labeler`
 */
module.exports = Labeler

/*
 * Initialize with CLI options and GitHub auth
 *
 * This allows us to not pass this stuff absolutely everwhere.
 *
 * opts = {
 *   destructive: <boolean>
 * }
}
*/
function Labeler(opts, auth) {
  this.opts = opts
  this.auth = {
      user: auth.token
    , pass: 'x-oauth-basic'
  }
}

/*
 * Setup the prototype functions
 */
var proto = Labeler.prototype

/* actions */
proto.add = add
proto.remove = remove
proto.update = update
proto.rename = rename
proto.standardize = standardize

/* utilities */
proto.handle_repo_labels = handle_repo_labels
proto.get_repos          = get_repos
proto.handle_label       = handle_label
proto.send_label         = send_label

var limiter = new RateLimiter({
  rate: 40,
  maxWaitingTime: 1000
});



/*
 * Adds a label with the specified name and color to all repos in an org.
 */
function* add(args) {
  var org   = args[0]
  var label = args[1]
  var color = args[2]

  if (!valid_color.test(color))
    throw new TypeError('color must be a valid hex color code without the \'#\': 09aF00')

  return yield* this.handle_label(org, 'POST', { name: label, color: color },
      'done adding labels')
}

/*
 * Removes a label with the specified name from all repos in an org.
 */
function* remove(args) {
  var org   = args[0]
  var label = args[1]

  return yield* this.handle_label(org, 'DELETE', { name: label, ext: label },
      'done removing labels')
}

/*
 * Updates an existing label with the specified name to the specified color for all repos in an org.
 */
function* update(args) {
  var org   = args[0]
  var label = args[1]
  var color = args[2]

  if (!valid_color.test(color))
    throw new TypeError('color must be a valid hex color code without the \'#\': 09aF00')

  return yield* this.handle_label(org, 'PATCH', { name: label, color: color, ext: label },
      'done updating labels')
}

/*
 * Renames an existing label with the specified revised name for all repos in an org.
 */
function* rename(args) {
  var org       = args[0]
  var label     = args[1]
  var new_label = args[2]

  return yield* this.handle_label(org, 'PATCH', { name: new_label, ext: label },
      'done renaming labels')
}

/*
 * Standardizes a json list of labels across all repos in an org.
 *
 * The json list must reside in a repo at config/github_labels.json
 */
function* standardize(args) {
  var org         = args[0]
  var config_repo = args[1]

  // if the config_repo isn't a user/repo path, make it one.
  if (!~config_repo.indexOf('/')) {
    config_repo = org + '/' + config_repo
  }

  console.log('https://api.github.com/repos/' + config_repo + '/contents/config/github_labels.json')
  var res = yield limiter.request({
      uri    : 'https://api.github.com/repos/' + config_repo + '/contents/config/github_labels.json'
    , headers: header
    , auth   : this.auth
    , json   : true
    , resolveWithFullResponse: true
  }).catch(log_request_err('error retrieving config from repo:'))

  if (!res) process.exit()

  // github sends the body (json file) as base64
  var config = JSON.parse(new Buffer(res.body.content, 'base64').toString('utf8'))
  if (!Array.isArray(config))
    throw new Error('error: github_labels.json must be a json array')

  // check if the org specifies a single repo via org/repo
  if (~org.indexOf('/')) {
    var org_and_repo = org.split('/')

    var repos = [org_and_repo[1]]
    org = org_and_repo[0]
  } else {
    // if no single repo is specified, do all the repos! \o/
    var repos = yield* this.get_repos(org)
  }

  console.log('checking %d labels across %d repos', config.length, repos.length)

  var i    = repos.length
  var reqs = []
  while (i--) {
    reqs.push(this.handle_repo_labels(org, repos[i], config, this.opts.destructive))
  }
  var results = yield reqs

  console.log(results)

  console.log('done standardizing labels')
}

/*
 * Handles differences between existing labels and a config list of labels.
 *
 * returns an array of responses
 */
function* handle_repo_labels(org, repo, config, destructive) {

  var uri = 'https://api.github.com/repos/' + org + '/' + repo + '/labels'
  console.log('handle_repo_labels')
  var res = yield limiter.request({
      uri    : uri
    , headers: header
    , method : 'GET'
    , json   : true
    , auth   : this.auth
  }).catch(log_request_err('error getting labels from a repo:'))

  if (!res) return []

  var list = compare_labels(config, res, destructive)

  var results = []

  var i = list.length
  console.log(`list length: ${i}`)
  while (i--) {
    item = list[i]
    console.log(i)
    console.log('request uri ',uri + (item.method === 'POST' ? '' : '/' + item.name))
    console.log('with item', item)
    var res = yield limiter.request({
        uri    : uri + (item.method === 'POST' ? '' : '/' + item.name)
      , headers: header
      , method : item.method
      , json   : item
      , auth   : this.auth
      , resolveWithFullResponse: true
    })
    console.log('request successful, response:\n',JSON.stringify(res.body))
    results.push(JSON.stringify(res.body))
  }

  return results
}

/*
 * Compares two lists of labels and determines the differences.
 *
 * returns a list of objects containing the needed JSON body and http method.
 */
function compare_labels(config, _existing, destructive) {
  var out = []
  var i   = config.length
  // don't splice the actual array
  var existing = _existing.body
  console.log('existing labels: ',existing)

  while (i--) {
    var wanted = config[i]
    var next   = false
    var j      = existing.length
    var current

    while (j--) {
      current = existing[j]
      if (wanted.name !== current.name) continue
      console.log('wanted.desc?', wanted.description)

      existing.splice(j, 1)
      next = {
          name  : wanted.name
        , color : wanted.color
        , description: wanted.description
        , method: 'PATCH'
      }
      break
    }
    if (next && wanted.color === current.color) continue

    out.push(next || {
        name  : wanted.name
      , color : wanted.color
      , description: wanted.description
      , method: 'POST'
    })
  }

  i = existing.length
  while (destructive && i--) {
    out.push({
        name  : existing[i].name
      , method: 'DELETE'
    })
  }

  return out
}

/*
 * Gets information about all of a GitHub organization's repos.
 *
 * returns a list of repos
 */
function* get_repos(org) {
  var repos = []
  var page  = 0
  var last_length = 0

  // handle github pagination for orgs with many repos
  while (++page) {
    console.log('get page of repos', 'https://api.github.com/orgs/' + org + '/repos?page=' + page)
    var res = yield limiter.request({
        uri    : 'https://api.github.com/orgs/' + org + '/repos?page=' + page
      , headers: header
      , auth   : this.auth
      , json   : true
    }).catch(log_request_err('error retrieving org\'s repos:'))

    var i = res.body.length
    while (i--) {
      repos.push(res.body[i].name)
    }

    // if this page has less repos than the last, then it is the last page.
    if (res.body.length === 0) break

    last_length = res.length
  }

  console.log('found %d repositories in %s\n', repos.length, org)

  return repos
}

/*
 * Handles getting repos and sending requests for single-label commands.
 *
 * See `send_label` for options
 *
 * returns an array of responses
 */
function* handle_label(org, method, opts, done) {
  var repos   = yield* this.get_repos(org)
  var results = yield* this.send_label(org, repos, opts, method)

  var i = results.length
  console.log('finished results')
  while (i--) {
     log_result(results[i], opts.name)
  }

  if (done) console.log(done)

  return yield results
}

/*
 * Applies a label via method & options to all repos.
 *
 * Options can contain:
 *   - The outgoing json, sent as the entire options.
 *   - The uri extension.
 *   - The http method, if not otherwise specified.
 *
 * returns an array of responses
 */
function* send_label(org, repos, opts, method) {
  var arr = []
  var i   = repos.length
  var completed = 0
  var uri = 'https://api.github.com/repos/' + org + '/'

  console.log('get ready to send a label update for each one in the repo')

  while (--i) {
    console.log('push label to ', uri + repos[i] + '/labels' + (opts.ext ? '/' + opts.ext : ''))
    arr.push(limiter.request({
        uri    : uri + repos[i] + '/labels' + (opts.ext ? '/' + opts.ext : '')
      , headers: header
      , method : method || opts.method
      , json   : opts
      , auth   : this.auth
      , resolveWithFullResponse: true
    }).then(function(res) {
      if(completed === 0) {
        console.log('res.request.uri', res.request.uri)
      }
      process.stdout.write(`\e[0K\rCompleted ${++completed} of ${repos.length}: ${res.request.uri.path} with status ${res.headers.status}`)
    })
    .catch(function(err) {
      console.log(`error sending labels from a repo:`, err)
      // console.log('headers', JSON.stringify(err.response.headers) +'\n')
      // console.log('body', err.response.body)
    }))
  }

  return yield arr
}

/*
 * Logs a two-dimensional [][] array of results.results
 *
 * returns the total number of results
 */
function log_results(results) {
  var updates = 0
  var repos   = []

  var i = results.length

  while (i--) {
    var sub = results[i]
    var j   = sub.length

    while (j--) {
      var result = sub[j]

      // increment counter on successful request (2XX code)
      if (('' + result.statusCode)[0] === "2") {
        updates++
        if (!~repos.indexOf(result.request.path))
          repos.push(result.request.path)
      }

      log_result(result)
    }
  }

  return { updates: updates, repos: repos.length }
}

/*
 * Logs a single response object.
 */
function log_result(result, label) {
  label = label || (result.body && result.body.name)
  // delete requests to github do not return bodies ..
  if (!label) {
    var path = result.request.path
    label = path.slice(path.lastIndexOf('/') + 1)
  }

  if (result.statusCode === 422)
    console.log('label `' + label + '` already exists at ' + result.request.path)

  else if (result.statusCode === 200)
    console.log('label `' + label + '` successfully updated at ' + result.request.path)

  else if (result.statusCode === 201)
    console.log('label `' + label + '` successfully created at ' + result.request.path)

  else if (result.statusCode === 204)
    console.log('label `' + label + '` successfully deleted from ' + result.request.path)

  else {
    if (result.request.path) console.log(result.request.path)
    console.log('status: ' + result.statusCode)
    if (result.body) console.log(result.body)
  }
}

/*
 * make a generic request error logger with a specified message
 */
function log_request_err(msg) {
  return function (err) {
    console.log(err)
    if (err.response && err.response.headers['x-ratelimit-remaining']>>0 === 0) {
      console.log('Exceded GitHub rate-limit. Bailing.')
      return process.exit()
    }

    console.log(msg, JSON.stringify(err.response.headers) +'\n')
  }
}
