const { Router } = require('express')
const WebTorrent = require('webtorrent')
const fs = require('fs')
require('events').EventEmitter.prototype._maxListeners = 100

const torrentFile = 'public/torrents.json'

const CONNECTED_USERS = []
const CURRENT_TORRENTS = {}

const api = (expressWs) => {
  const router = Router()

  const client = new WebTorrent()

  writeOnTimer() // Start a timer to write to disk every 60s

  client.on('error', (error) => {
    let err = error.toString()
    for (const user of CONNECTED_USERS) {
      if (user.readyState === 1) {
        user.send(JSON.stringify({ status: 'error', err }))
      }
    }
  })

  // Add torrents to start downloading from previous opening
  openTorrents()
    .then(torrents => {
      for (const prop in torrents) {
        CURRENT_TORRENTS[torrents[prop].infoHash] = torrents[prop]
        let opts = {
          path: torrents[prop].path
        }
        new Promise((resolve) => {
          client.add(torrents[prop].infoHash, opts, (parsedTorrent) => {
            parsedTorrent.on('error', (err) => {
              reject(err)
            })
            resolve(parsedTorrent)
          })
        })
          .then((torrent) => subscribeTorrents(client, torrent))
          .catch((err) => {
              for (const user of CONNECTED_USERS) {
                if (user.readyState === 1) {
                  user.send(JSON.stringify({ status: 'error', err }))
                }
              }
           })
      }
    })
    .catch(e => console.log(e))

  router.ws('/', (ws, req, next) => {
    const aWss = expressWs.getWss('/a')

    aWss.clients.forEach(user => {
      user.id = generateID()
      user.counter = 0
      if (CONNECTED_USERS.map(e => { return e.id }).indexOf(user.id) === -1) {
        CONNECTED_USERS.push(user)
      }
      for (const torrent of client.torrents) {
        if (user.readyState === 1) {
          user.send(JSON.stringify({ status: 'update', data: destructureTorrent(torrent) }))
        }
      }
    }) 

    ws.on('message', (message) => {
      const parsed = JSON.parse(message)
      if (typeof parsed.data === 'undefined') {
        return next('No torrent provided')
      } else if (parsed.status === 'addTorrent') {
        // Add torrent to client
        let opts = {}
        if (parsed.location !== '') {
          opts = {
            path: `${parsed.location}\\${stringToSlug(parsed.title)}`
          }
        }
        client.add(parsed.data, opts, (torrent) => {
          console.log('Adding torrent: ' + torrent.infoHash)

          CURRENT_TORRENTS[torrent.infoHash] = torrent

          torrent.on('download', (bytes) => {
            sendDownloadInformation(torrent)
          })

          torrent.on('done', () => {
            completeTorrent(torrent)
              .catch(e => {
                let err = e.toString()
                return next(err)              
              })              
          })

          for (const user of CONNECTED_USERS) {
            if (user.readyState === 1) {
              user.send(JSON.stringify({ status: 'start', data: destructureTorrent(torrent) }))
            }
          }
        })
      } else if (parsed.status === 'removeTorrent') {
        const torrent = client.get(parsed.data.infoHash)

        if (torrent != null) {
          delete CURRENT_TORRENTS[torrent.infoHash]    
          for (let p in torrent._peers) {
            if (torrent._peers[p].wire != null) {
              torrent.wires.push(torrent._peers[p].wire)
            }
          }
          torrent.resume()

          client.remove(torrent, (err) => {
            if (err) return next(err)
          })

          for (const user of CONNECTED_USERS) {
            if (user.readyState === 1) {
              user.send(JSON.stringify({ status: 'delete', data: parsed.data }))
            }
          }
        }

      } else if (parsed.status === 'pauseTorrent') {
        const torrent = client.get(parsed.data.infoHash)
        if (torrent != null) {
          torrent.pause()
          torrent.wires = []
        }
      } else if (parsed.status === 'resumeTorrent') {
        const torrent = client.get(parsed.data.infoHash)
        for (let p in torrent._peers) {
          if (torrent._peers[p].wire != null) {
            torrent.wires.push(torrent._peers[p].wire)
          }
        }
        torrent.resume()
      }
    })
  })

  return router
}

const generateID = () => {
  return '_' + Math.random().toString(36).substr(2, 9)
}

const subscribeTorrents = (client, torrent) => {
  // Add torrents without extra information to array
  console.log('Loaded torrent ' + torrent.infoHash + ' from JSON, subscribing to events')

  if (torrent.timeRemaining === 0) {
    completeTorrent(torrent)
      .catch(e => {
        let err = e.toString()
        return next(err)
      })    
  }

  torrent.on('download', (bytes) => {
    sendDownloadInformation(torrent)
  })

  torrent.on('done', () => {
    completeTorrent(torrent)
      .catch(e => {
        let err = e.toString()
        return next(err)
      })    
  })
}

const sendDownloadInformation = (torrent) => {
  for (const user of CONNECTED_USERS) {
    const index = CONNECTED_USERS.map(e => { return e.id }).indexOf(user.id)
    let interval = calculateInterval(torrent)
    if (user.counter % interval === 0) { 
      if (user.readyState === 1) {
        user.send(JSON.stringify({ status: 'update', data: destructureTorrent(torrent) }))
      } else {
        console.log('Terminating' + user.id)
        CONNECTED_USERS.splice(index, 1)
        user.terminate()
      }
    }
    user.counter++
  }  
}

const calculateInterval = (torrent) => {
  let inHigh = 13491245
  let inLow = 1000

  let outLow = possibleIntervals[0]
  let outHigh = possibleIntervals[6]

  let inSpan = inHigh - inLow  
  let outSpan = outHigh - outLow

  let scaleFactor = parseFloat(outSpan) / parseFloat(inSpan)

  let num = torrent.downloadSpeed

  let interval =  outLow + (num - inLow)*scaleFactor
  return possibleIntervals.reduce((prev, curr) => {
    return (Math.abs(curr - interval) < Math.abs(prev - interval) ? curr : prev);
  })
  
}

const possibleIntervals = [1, 2, 4, 10, 50, 100, 200, 400]

const completeTorrent = (torrent) => {
  return new Promise((resolve, reject) => {
    console.log('Torrent complete')

    delete CURRENT_TORRENTS[torrent.infoHash]

    torrent.removeListener('download', () => {
      console.log('Removed download listener for ' + torrent.infoHash)
    })

    for (const user of CONNECTED_USERS) {
      if (user.readyState === 1) {
        user.send(JSON.stringify({ status: 'complete', data: destructureTorrent(torrent) }))
      }
    }
    resolve()
  })
}

const writeTorrents = () => {
  return new Promise((resolve, reject) => {
    fs.writeFile(torrentFile, JSON.stringify(CURRENT_TORRENTS, null, 4), (err) => {
      if (err) return reject(err)
      return resolve()
    })
  })
}

const openTorrents = () => {
  return new Promise((resolve, reject) => {
    fs.readFile(torrentFile, (err, data) => {
      if (err) return reject(err)
      let json
      try {
        json = JSON.parse(data)
      } catch (e) {
        return reject(e)
      }
      return resolve(json)
    })
  })
}

const destructureTorrent = (torrent) => {
  let file = {
    name: typeof torrent.files[0] === 'undefined' ? '' : torrent.files[0].name,
    infoHash: torrent.infoHash,
    timeRemaining: torrent.timeRemaining,
    received: torrent.received,
    downloaded: torrent.downloaded,
    uploaded: torrent.uploaded,
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    progress: torrent.progress,
    ratio: torrent.ratio,
    numPeers: torrent.numPeers,
    path: torrent.path
  }
  return file
}

const writeOnTimer = () => {
  setInterval(() => {
    writeTorrents()
      .catch(e => console.log(e))
  }, 10000)
}

function stringToSlug (str) {
  str = str.replace(/^\s+|\s+$/g, '') // trim
  str = str.toLowerCase()

  // remove accents, swap ñ for n, etc
  var from = 'àáäâèéëêìíïîòóöôùúüûñç·/_,:;'
  var to = 'aaaaeeeeiiiioooouuuunc------'
  for (var i = 0, l = from.length; i < l; i++) {
    str = str.replace(new RegExp(from.charAt(i), 'g'), to.charAt(i))
  }

  str = str.replace(/[^a-z0-9 -]/g, '') // remove invalid chars
    .replace(/\s+/g, '-') // collapse whitespace and replace by -
    .replace(/-+/g, '-') // collapse dashes

  return str
}

module.exports = api
