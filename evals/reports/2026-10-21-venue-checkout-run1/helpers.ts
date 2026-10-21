// Functions of their arguments: money, dates, card numbers, postal codes, and the
// bars of a Code 128 barcode. Nothing here knows about the program's model.

export function money(cents: number): string {
    const sign = cents < 0 ? "-" : ""
    const c = Math.abs(Math.round(cents))
    const dollars = Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    return sign + "$" + dollars + "." + String(c % 100).padStart(2, "0")
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const MON_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

// "2026-11-13T19:30" is the hall's local time, as printed on a ticket: read the
// parts as written, never through a time zone

function parts(iso: string): { y: number, m: number, d: number, h: number, min: number, dow: number } {
    const [date, time] = (iso ?? "2000-01-01T00:00").split("T")
    const [y, m, d] = date.split("-").map(Number)
    const [h, min] = (time ?? "00:00").split(":").map(Number)
    return { y, m, d, h, min, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() }
}

export function dayLabel(iso: string): string {
    const p = parts(iso)
    return DOW[p.dow] + " " + p.d + " " + MON[p.m - 1]
}
export function shortDate(iso: string): string {
    const p = parts(iso)
    return p.d + " " + MON[p.m - 1]
}
export function longDay(iso: string): string {
    const p = parts(iso)
    return DOW_LONG[p.dow] + " " + p.d + " " + MON_LONG[p.m - 1]
}
export function weekday(iso: string): string { return DOW[parts(iso).dow] }
export function dayNum(iso: string): string { return "" + parts(iso).d }
export function monthName(iso: string): string { return MON_LONG[parts(iso).m - 1] }
export function monthKey(iso: string): string { return iso.slice(0, 7) }

export function timeLabel(iso: string): string {
    const p = parts(iso)
    const h12 = p.h % 12 == 0 ? 12 : p.h % 12
    return h12 + ":" + String(p.min).padStart(2, "0") + (p.h < 12 ? "am" : "pm")
}

export function seatsWord(n: number): string { return n == 1 ? "1 seat" : n + " seats" }

// ── cards ──

type Brand = "visa" | "mastercard" | "amex" | "discover" | ""

export function digitsOf(s: string): string { return s.replace(/\D/g, "") }

export function brandOf(digits: string): Brand {
    if (/^4/.test(digits)) return "visa"
    if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits)) return "mastercard"
    if (/^3[47]/.test(digits)) return "amex"
    if (/^(6011|65|64[4-9]|622)/.test(digits)) return "discover"
    return ""
}

export function brandName(b: string): string {
    return b == "visa" ? "Visa" : b == "mastercard" ? "Mastercard" : b == "amex" ? "American Express" : b == "discover" ? "Discover" : ""
}

function lengthsFor(b: Brand): number[] {
    return b == "amex" ? [15] : b == "visa" ? [13, 16, 19] : b == "discover" ? [16, 17, 18, 19] : b == "mastercard" ? [16] : [16]
}
export function maxDigits(b: Brand): number { const l = lengthsFor(b); return l[l.length - 1] }
export function cvcLength(b: string): number { return b == "amex" ? 4 : 3 }

// printed as on the card: 4-6-5 for American Express, fours for the rest
export function groupCard(digits: string): string {
    const b = brandOf(digits)
    const d = digits.slice(0, maxDigits(b))
    if (b == "amex") return [d.slice(0, 4), d.slice(4, 10), d.slice(10, 15)].filter((g) => g != "").join(" ")
    return (d.match(/.{1,4}/g) ?? []).join(" ")
}

function luhn(d: string): boolean {
    let sum = 0
    for (let i = 0; i < d.length; i++) {
        let n = Number(d[d.length - 1 - i])
        if (i % 2 == 1) { n = n * 2; if (n > 9) n = n - 9 }
        sum = sum + n
    }
    return sum % 10 == 0
}

// "" when it could be a card number; otherwise what is wrong, in a sentence
export function cardNumberProblem(digits: string): string {
    if (digits == "") return "Enter the card number."
    const b = brandOf(digits)
    if (b == "") return "That isn't a card number we recognise."
    if (!lengthsFor(b).includes(digits.length)) return "That card number is too " + (digits.length < lengthsFor(b)[0] ? "short." : "long.")
    if (!luhn(digits)) return "That card number isn't right — check the digits."
    return ""
}

// expiry typed as digits, shown "MM / YY"
export function groupExpiry(digits: string): string {
    const d = digits.slice(0, 4)
    // a lone first digit above 1 can only be a single-digit month
    if (d.length == 1 && Number(d) > 1) return "0" + d + " / "
    return d.length <= 2 ? d : d.slice(0, 2) + " / " + d.slice(2)
}
export function expiryDigits(typed: string): string {
    // what autofill writes: "04/28", "4/2028"
    const m = typed.match(/^\s*(\d{1,2})\s*\/\s*(\d{2}|\d{4})\s*$/)
    if (m != null) return m[1].padStart(2, "0") + m[2].slice(-2)
    const d = digitsOf(typed)
    return /^[2-9]/.test(d) ? ("0" + d).slice(0, 4) : d.slice(0, 4)
}
export function expiryProblem(digits: string, nowYear: number, nowMonth: number): string {
    if (digits == "") return "Enter the expiry date."
    if (digits.length < 4) return "Enter the expiry as MM / YY."
    const m = Number(digits.slice(0, 2)), y = 2000 + Number(digits.slice(2, 4))
    if (m < 1 || m > 12) return "That month isn't one — use 01 to 12."
    if (y < nowYear || (y == nowYear && m < nowMonth)) return "That card has expired."
    if (y > nowYear + 20) return "That expiry is too far away."
    return ""
}
export function expMonth(digits: string): number { return Number(digits.slice(0, 2)) }
export function expYear(digits: string): number { return 2000 + Number(digits.slice(2, 4)) }

export function cvcProblem(code: string, brand: string): string {
    const n = cvcLength(brand)
    if (code == "") return "Enter the security code."
    if (!/^\d+$/.test(code) || code.length != n) return "The security code is " + n + " digits" + (brand == "amex" ? ", on the front of the card." : ", on the back of the card.")
    return ""
}

export function emailProblem(email: string): string {
    const e = email.trim()
    if (e == "") return "Enter an email address — your tickets are sent there."
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return "That email address isn't complete."
    return ""
}

// ── postal codes ──

const POSTAL: Record<string, RegExp> = {
    US: /^\d{5}(-\d{4})?$/,
    CA: /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/,
    GB: /^(GIR ?0AA|[A-PR-UWYZ]([0-9]{1,2}|[A-HK-Y][0-9]([0-9ABEHMNPRV-Y])?|[0-9][A-HJKPS-UW]) ?[0-9][ABD-HJLNP-UW-Z]{2})$/
}

export function postalProblem(code: string, country: string): string {
    const c = code.trim().toUpperCase()
    const word = country == "US" ? "ZIP code" : "postcode"
    if (c == "") return "Enter the " + (country == "US" ? "ZIP code." : country == "CA" ? "postal code." : "postcode.")
    const re = POSTAL[country]
    if (re != null && !re.test(c)) {
        return country == "US" ? "A ZIP code is 5 digits, like 94103."
            : country == "CA" ? "A Canadian postal code looks like K1A 0B1."
            : "That isn't a UK " + word + " — it looks like SW1A 2AA."
    }
    return ""
}

// how the country's codes look, said beside the field
export function postalLabel(country: string): string {
    return country == "US" ? "ZIP code, like 94103" : country == "CA" ? "Like K1A 0B1" : "Postcode, like SW1A 2AA"
}

// the country a postal code can only belong to, or "" when it could be several or none
export function countryOfPostal(code: string): string {
    const c = code.trim().toUpperCase()
    const hits = Object.keys(POSTAL).filter((k) => POSTAL[k].test(c))
    return hits.length == 1 ? hits[0] : ""
}

// ── Code 128 (set B): the bar and space widths, in modules, for a code ──

const C128 = [
    "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
    "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
    "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
    "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
    "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
    "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
    "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
    "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
    "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
    "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
    "114131", "311141", "411131", "211412", "211214", "211232", "2331112"
]

export function code128(text: string): number[] {
    const codes = [104]
    for (const ch of text) codes.push(Math.max(0, Math.min(94, ch.charCodeAt(0) - 32)))
    let sum = 104
    for (let i = 1; i < codes.length; i++) sum = sum + codes[i] * i
    codes.push(sum % 103)
    codes.push(106)
    const widths: number[] = []
    for (const c of codes) for (const w of C128[c]) widths.push(Number(w))
    return widths
}
