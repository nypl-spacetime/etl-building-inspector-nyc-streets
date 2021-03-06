const fs = require('fs')
const path = require('path')
const H = require('highland')
const R = require('ramda')
const turf = {
  lineSegment: require('@turf/line-segment'),
  crosstrack: require('turf-crosstrack')
}
const IndexedGeo = require('indexed-geo')
const fuzzyDates = require('fuzzy-dates')

const YEAR_THRESHOLD = 15
const MAX_DISTANCE = 25

const DATASETS = {
  streets: 'nyc-streets',
  houseNumbers: 'building-inspector'
}

function getFullId (dataset, id) {
  if (id.includes('/')) {
    return id
  }

  return `${dataset}/${id}`
}

function getInternalId (id) {
  if (id.includes('/')) {
    return id.split('/')[1]
  }

  return id
}

function objectsStream (getDir, dataset, step) {
  const objectsFile = path.join(getDir(dataset, step), `${dataset}.objects.ndjson`)
  return H(fs.createReadStream(objectsFile))
    .split()
    .compact()
    .map(JSON.parse)
}

function processAddresses (indexedGeo, dirs, tools, callback) {
  console.log('      Finding closest line segments for each house number')

  const MS_THRESHOLD = YEAR_THRESHOLD * 365 * 24 * 60 * 60 * 1000

  let count = 0
  objectsStream(dirs.getDir, DATASETS.houseNumbers, 'transform')
    .filter((object) => object.type === 'st:Address')
    .filter((houseNumber) => houseNumber.geometry)
    .map((houseNumber) => {
      count++
      if (count % 10000 === 0) {
        console.log(`        Processed ${count} house numbers`)
      }
      return houseNumber
    })
    .map((houseNumber) => {
      const searchResults = indexedGeo.search(houseNumber.geometry)
      const nearestResults = indexedGeo.nearest(houseNumber.geometry, 10)
      const allResults = [...searchResults, ...nearestResults]

      const closestResults = allResults
        .filter((segment) => {
          const addressSince = new Date(fuzzyDates.convert(houseNumber.validSince)[0]).getTime()
          const addressUntil = new Date(fuzzyDates.convert(houseNumber.validUntil)[1]).getTime()

          const segmentSince = new Date(fuzzyDates.convert(segment.properties.validSince)[0]).getTime() - MS_THRESHOLD
          const segmentUntil = new Date(fuzzyDates.convert(segment.properties.validUntil)[1]).getTime() + MS_THRESHOLD

          return segmentSince <= addressSince && segmentUntil >= addressUntil
        })
        .map((segment) => {
          const distance = Math.round(turf.crosstrack(houseNumber.geometry, segment, 'kilometers') * 1000)
          return {
            segment,
            distance
          }
        })
        .filter((segment) => segment.distance < MAX_DISTANCE)
        .sort((a, b) => a.distance - b.distance)

      const id = getInternalId(houseNumber.id)
      const houseNumberId = getFullId(DATASETS.houseNumbers, houseNumber.id)

      if (closestResults.length) {
        const distance = closestResults[0].distance
        const segment = closestResults[0].segment
        const streetId = getFullId(DATASETS.streets, segment.properties.id)

        const name = `${houseNumber.data.number} ${segment.properties.name}`

        return {
          id,
          name,
          houseNumberId,
          streetId,
          validSince: houseNumber.validSince,
          validUntil: houseNumber.validUntil,
          streetName: segment.properties.name,
          addressData: houseNumber.data,
          lineLength: distance,
          addressGeometry: houseNumber.geometry
        }
      } else {
        return {
          error: `Can't find street within ${MAX_DISTANCE} meters and ${YEAR_THRESHOLD} years`,
          houseNumberId,
          addressData: houseNumber.data,
          addressGeometry: houseNumber.geometry
        }
      }
    })
    .compact()
    .stopOnError(callback)
    .map(JSON.stringify)
    .intersperse('\n')
    .pipe(fs.createWriteStream(path.join(dirs.current, 'inferred.ndjson')))
    .on('finish', callback)
}

function infer (config, dirs, tools, callback) {
  objectsStream(dirs.getDir, DATASETS.streets, 'transform')
    .filter((street) => street.geometry)
    .map((street) => {
      const feature = {
        type: 'Feature',
        properties: R.omit('geometry', street),
        geometry: street.geometry
      }

      const segments = turf.lineSegment(feature)
      return segments.features
    })
    .flatten()
    .toArray((segments) => {
      if (!segments.length) {
        callback('No streets with geometries found - this is very wrong!')
        return
      }

      console.log('      Indexing street segments')

      try {
        const geojson = {
          type: 'FeatureCollection',
          features: segments
        }
        const indexedGeo = IndexedGeo()

        indexedGeo.index(geojson)

        console.log('        Done!')

        processAddresses(indexedGeo, dirs, tools, callback)
      } catch (err) {
        callback(err)
      }
    })
}

function transform (config, dirs, tools, callback) {
  H(fs.createReadStream(path.join(dirs.previous, 'inferred.ndjson')))
    .split()
    .compact()
    .map(JSON.parse)
    .map((address) => {
      if (address.streetId) {
        return [
          {
            type: 'object',
            obj: {
              id: address.id,
              name: address.name,
              type: 'st:Address',
              validSince: address.validSince,
              validUntil: address.validUntil,
              data: Object.assign(address.addressData, {
                houseNumberId: address.houseNumberId,
                streetId: address.streetId
              }),
              geometry: address.addressGeometry
            }
          },
          {
            type: 'relation',
            obj: {
              from: address.houseNumberId,
              to: address.streetId,
              type: 'st:in'
            }
          },
          {
            type: 'relation',
            obj: {
              from: address.id,
              to: address.houseNumberId,
              type: 'st:sameAs'
            }
          },
          {
            type: 'log',
            obj: {
              houseNumberId: address.houseNumberId,
              streetId: address.streetId,
              streetName: address.streetName,
              addressData: address.addressData,
              lineLength: address.lineLength,
              geometry: address.addressGeometry
            }
          }
        ]
      } else if (address.error) {
        return {
          type: 'log',
          obj: {
            error: `Can't find street within ${MAX_DISTANCE} meters and ${YEAR_THRESHOLD} years`,
            houseNumberId: address.houseNumberId,
            addressData: address.addressData,
            geometry: address.addressGeometry
          }
        }
      }
    })
    .stopOnError(callback)
    .flatten()
    .map(H.curry(tools.writer.writeObject))
    .nfcall([])
    .series()
    .stopOnError(callback)
    .done(callback)
}

// ==================================== API ====================================

module.exports.steps = [
  infer,
  transform
]
