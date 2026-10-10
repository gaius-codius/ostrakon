// ULIDs: 48-bit millisecond time + 80 random bits, Crockford base32, 26 characters.
// Sortable by creation time and unique across machines without coordination.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const encodeTime = (ms: number) => {
  let out = ''
  let rest = Math.floor(ms)
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[rest % 32] + out
    rest = Math.floor(rest / 32)
  }
  return out
}

const randomPart = (random: (n: number) => Uint8Array) =>
  Array.from(random(16), byte => ALPHABET[byte % 32]).join('')

// Within one millisecond, increment the random part so ids stay strictly increasing.
const increment = (part: string) => {
  const chars = part.split('')
  for (let i = chars.length - 1; i >= 0; i--) {
    const next = ALPHABET.indexOf(chars[i] ?? '0') + 1
    if (next < 32) {
      chars[i] = ALPHABET[next] ?? '0'
      return chars.join('')
    }
    chars[i] = '0'
  }
  throw new Error('ulid: random part overflowed within one millisecond')
}

const cryptoRandom = (n: number) => crypto.getRandomValues(new Uint8Array(n))

let lastTime = -1
let lastRandom = ''

export const ulid = (now: number, random: (n: number) => Uint8Array = cryptoRandom) => {
  if (now === lastTime) {
    lastRandom = increment(lastRandom)
  } else {
    lastTime = now
    lastRandom = randomPart(random)
  }
  return encodeTime(now) + lastRandom
}

export const ulidTime = (id: string) =>
  id
    .slice(0, 10)
    .split('')
    .reduce((ms, char) => ms * 32 + ALPHABET.indexOf(char), 0)

export const isUlid = (id: string) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)
