'use strict';
const {germanMoneyNumber,germanInteger}=require('./german_numbers');

function speechPlaceholders(language) {
  return language === 'de' ? {link:'ein Link',path:'ein Dateipfad'}
    : language === 'zh' ? {link:'链接',path:'文件路径'} : {link:'a link',path:'a file path'};
}

// ISO codes stay case-sensitive so ordinary words and variable names are untouched.
const CURRENCIES = [
  ['US\\$|USD', 'US-Dollar', 'US dollar', 'US dollars'],
  ['NT\\$|TWD', 'Taiwan-Dollar', 'Taiwan dollar', 'Taiwan dollars'],
  ['HK\\$|HKD', 'Hongkong-Dollar', 'Hong Kong dollar', 'Hong Kong dollars'],
  ['CA\\$|C\\$|CAD', 'kanadische Dollar', 'Canadian dollar', 'Canadian dollars'],
  ['AU\\$|A\\$|AUD', 'australische Dollar', 'Australian dollar', 'Australian dollars'],
  ['€|EUR', 'Euro', 'euro', 'euros'],
  ['£|GBP', 'britische Pfund', 'British pound', 'British pounds'],
  ['CHF', 'Schweizer Franken', 'Swiss franc', 'Swiss francs'],
  ['JPY', 'japanische Yen', 'Japanese yen', 'Japanese yen'],
  ['CNY|RMB', 'chinesische Yuan', 'Chinese yuan', 'Chinese yuan'],
  ['¥', 'Yen oder Yuan', 'yen or yuan', 'yen or yuan'],
  ['₩|KRW', 'südkoreanische Won', 'South Korean won', 'South Korean won'],
  ['₹|INR', 'indische Rupien', 'Indian rupee', 'Indian rupees'],
  ['₺|TRY', 'türkische Lira', 'Turkish lira', 'Turkish lira'],
  ['₴|UAH', 'ukrainische Hrywnja', 'Ukrainian hryvnia', 'Ukrainian hryvnias'],
  ['₽|RUB', 'russische Rubel', 'Russian ruble', 'Russian rubles'],
  ['PLN', 'polnische Zloty', 'Polish zloty', 'Polish zlotys'],
  ['SEK', 'schwedische Kronen', 'Swedish krona', 'Swedish kronor'],
  ['NOK', 'norwegische Kronen', 'Norwegian krone', 'Norwegian kroner'],
  ['DKK', 'dänische Kronen', 'Danish krone', 'Danish kroner'],
  ['\\$', 'Dollar', 'dollar', 'dollars'],
];
const AMOUNT = '[+−-]?\\d+(?:[.,]\\d+)*';
function localizedNumber(raw, de) {
  let value=raw.replace('−','-');
  const negative=value.startsWith('-'),positive=value.startsWith('+');
  value=value.replace(/^[+-]/,'');
  // Mixed separators identify the decimal mark; a single three-digit group
  // is kept as a thousands group. No exchange-rate or value conversion.
  const last=Math.max(value.lastIndexOf('.'),value.lastIndexOf(','));
  if(last>=0){
    const decimal=value.length-last-1!==3 || (value.includes('.')&&value.includes(',')) || /^0[.,]/.test(value) || (de && !value.includes('.') && value.includes(',')) || (!de && !value.includes(',') && value.includes('.'));
    if(decimal)value=value.slice(0,last).replace(/[.,]/g,'')+(de?',':'.')+value.slice(last+1);
    else value=value.replace(/[.,]/g,'');
  }
  return `${negative?'minus ':positive?'plus ':''}${value}`;
}
const UNITS = [
  ['km/h','Kilometer pro Stunde','kilometer per hour','kilometers per hour'],
  ['m/s2','Meter pro Sekunde zum Quadrat','meter per second squared','meters per second squared'],
  ['m/s','Meter pro Sekunde','meter per second','meters per second'],
  ['km2','Quadratkilometer','square kilometer','square kilometers'],
  ['m2','Quadratmeter','square meter','square meters'],
  ['dm2','Quadratdezimeter','square decimeter','square decimeters'],
  ['cm2','Quadratzentimeter','square centimeter','square centimeters'],
  ['mm2','Quadratmillimeter','square millimeter','square millimeters'],
  ['km3','Kubikkilometer','cubic kilometer','cubic kilometers'],
  ['m3','Kubikmeter','cubic meter','cubic meters'],
  ['dm3','Kubikdezimeter','cubic decimeter','cubic decimeters'],
  ['cm3','Kubikzentimeter','cubic centimeter','cubic centimeters'],
  ['mm3','Kubikmillimeter','cubic millimeter','cubic millimeters'],
  ['km','Kilometer','kilometer','kilometers'], ['m','Meter','meter','meters'],
  ['dm','Dezimeter','decimeter','decimeters'], ['cm','Zentimeter','centimeter','centimeters'],
  ['mm','Millimeter','millimeter','millimeters'], ['μm','Mikrometer','micrometer','micrometers'],
  ['nm','Nanometer','nanometer','nanometers'],
  ['ha','Hektar','hectare','hectares'],
  ['l','Liter','liter','liters'], ['L','Liter','liter','liters'],
  ['dl','Deziliter','deciliter','deciliters'], ['dL','Deziliter','deciliter','deciliters'],
  ['cl','Zentiliter','centiliter','centiliters'], ['cL','Zentiliter','centiliter','centiliters'],
  ['ml','Milliliter','milliliter','milliliters'], ['mL','Milliliter','milliliter','milliliters'],
  ['μl','Mikroliter','microliter','microliters'], ['μL','Mikroliter','microliter','microliters'],
  ['kg','Kilogramm','kilogram','kilograms'], ['g','Gramm','gram','grams'],
  ['mg','Milligramm','milligram','milligrams'], ['μg','Mikrogramm','microgram','micrograms'],
  ['t','Tonnen','tonne','tonnes'],
  ['s','Sekunden','second','seconds'], ['ms','Millisekunden','millisecond','milliseconds'],
  ['min','Minuten','minute','minutes'], ['h','Stunden','hour','hours'],
  ['kWh','Kilowattstunden','kilowatt hour','kilowatt hours'], ['Wh','Wattstunden','watt hour','watt hours'],
  ['J','Joule','joule','joules'], ['kJ','Kilojoule','kilojoule','kilojoules'], ['MJ','Megajoule','megajoule','megajoules'],
  ['W','Watt','watt','watts'], ['mW','Milliwatt','milliwatt','milliwatts'],
  ['kW','Kilowatt','kilowatt','kilowatts'], ['MW','Megawatt','megawatt','megawatts'],
  ['Hz','Hertz','hertz','hertz'], ['kHz','Kilohertz','kilohertz','kilohertz'],
  ['MHz','Megahertz','megahertz','megahertz'], ['GHz','Gigahertz','gigahertz','gigahertz'],
  ['Pa','Pascal','pascal','pascals'], ['hPa','Hektopascal','hectopascal','hectopascals'],
  ['kPa','Kilopascal','kilopascal','kilopascals'], ['MPa','Megapascal','megapascal','megapascals'],
  ['bar','Bar','bar','bar'], ['mbar','Millibar','millibar','millibar'],
  ['V','Volt','volt','volts'], ['mV','Millivolt','millivolt','millivolts'], ['kV','Kilovolt','kilovolt','kilovolts'],
  ['A','Ampere','ampere','amperes'], ['mA','Milliampere','milliampere','milliamperes'],
  ['Ω','Ohm','ohm','ohms'], ['kΩ','Kiloohm','kiloohm','kiloohms'], ['MΩ','Megaohm','megaohm','megaohms'],
  ['N','Newton','newton','newtons'], ['Nm','Newtonmeter','newton meter','newton meters'],
  ['mol','Mol','mole','moles'], ['mmol','Millimol','millimole','millimoles'],
];
const GERMAN_SINGULAR = {Tonnen:'Tonne',Sekunden:'Sekunde',Millisekunden:'Millisekunde',Minuten:'Minute',Stunden:'Stunde',Kilowattstunden:'Kilowattstunde',Wattstunden:'Wattstunde',
  'kanadische Dollar':'kanadischer Dollar','australische Dollar':'australischer Dollar','britische Pfund':'britisches Pfund','indische Rupien':'indische Rupie','schwedische Kronen':'schwedische Krone','norwegische Kronen':'norwegische Krone','dänische Kronen':'dänische Krone'};
function isOne(raw){return Math.abs(Number(localizedNumber(raw,false).replace(/^minus /,'-').replace(/^plus /,'')))===1;}
function unitName(raw, de, german, singular, plural){return de?(isOne(raw)?GERMAN_SINGULAR[german]||german:german):isOne(raw)?singular:plural;}
const UNIT_NAMES=new Map(UNITS.map(row=>[row[0],row]));
const UNIT_PATTERN=[...UNIT_NAMES.keys()].sort((a,b)=>b.length-a.length).join('|');
function normalizePhysicalUnits(out, de){
  // NFKC already turns superscripts into digits. Also accept explicit ^2/^3.
  out=out.replace(/(?<![\p{L}_])((?:k|d|c|m)?m)\^([23])\b/gu,'$1$2');
  out=out.replace(/\bm\/s\^2\b/g,'m/s2');
  return out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])(${AMOUNT})\\s*(${UNIT_PATTERN})(?![\\p{L}\\p{N}_^/])`,'gu'),(_,raw,unit)=>{
    const [,german,singular,plural]=UNIT_NAMES.get(unit);
    return `${localizedNumber(raw,de)} ${unitName(raw,de,german,singular,plural)}`;
  });
}

function normalizeMeasurements(text, language) {
  const de=language==='de';
  let out=text;
  for(const [pattern,german,singular,plural] of CURRENCIES){
    const name=raw=>unitName(raw,de,german,singular,plural);
    const speak=raw=>{const currency=name(raw);const amount=localizedNumber(raw,de);return `${de?germanMoneyNumber(amount,currency):amount} ${currency}`;};
    out=out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})\\s*(${AMOUNT})(?!\\d|[.,]\\d)`,'gu'),(_,n)=>speak(n));
    out=out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])(${AMOUNT})\\s*(?:${pattern})(?![\\p{L}\\p{N}_])`,'gu'),(_,n)=>speak(n));
  }
  out=out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])(${AMOUNT})\\s*(?:°\\s*(C|F|K|Celsius|Fahrenheit)?|(?<kelvin>K))(?![\\p{L}\\p{N}_])`,'gu'),(_,raw,unit,kelvin)=>{
    const name=kelvin||unit||'';
    const number=localizedNumber(raw,de);
    if(name==='K')return `${number} Kelvin`;
    const scale=({C:'Celsius',F:'Fahrenheit'})[name]||name;
    const degree=de?'Grad':Math.abs(Number(raw.replace(',','.')) )===1?'degree':'degrees';
    return `${number} ${degree}${scale?' '+scale:''}`;
  });
  out=out.replace(/°\s*(C|F|K)\b/g,(_,unit)=>unit==='K'?' Kelvin':` ${de?'Grad':'degrees'} ${{C:'Celsius',F:'Fahrenheit'}[unit]}`);
  return out;
}

function normalizeSpeechSymbols(text, language) {
  text=String(text).replace(/\*/g,'');
  if (!['de','en'].includes(language)) return text;
  const de=language==='de';
  let out=String(text).normalize('NFKC');
  const placeholders=speechPlaceholders(language);
  out=out.replace(/https?:\/\/[^\s<>]+/gi,placeholders.link);
  // A path contains several segments; /app and /help remain audible commands.
  out=out.replace(/\b[A-Za-z]:[\\/][^\s"'`<>]+/g,placeholders.path);
  out=out.replace(/(^|[\s("'`])~?\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g,(_,prefix)=>prefix+placeholders.path);
  out=normalizeMeasurements(out,language);
  out=normalizePhysicalUnits(out,de);
  // Standalone progress counters; leave dates, paths and unit slashes alone.
  out=out.replace(/(?<![\p{L}\p{N}_/.,+\-])(\d{1,6})[ \t]*\/[ \t]*(\d{1,6})(?![\p{L}\p{N}_/]|[.,]\d|[ \t]*\/)/gu,
    (match,current,total)=>Number(total)>0
      ? de?`${germanInteger(Number(current))} von ${germanInteger(Number(total))}`:`${Number(current)} of ${Number(total)}`
      :match);

  out=out.replace(/(^|[\s([{<=])\+(\d)/g,(_,prefix,n)=>`${prefix}${de?'plus':'plus'} ${n}`);
  out=out.replace(/(^|[\s([{<=])-(\d)/g,(_,prefix,n)=>`${prefix}${de?'minus':'minus'} ${n}`);
  const symbolNames = de ? [
    ['+', ' Pluszeichen '],
    ['×', ' Malzeichen '],
    ['÷', ' geteilt durch '],
    ['=', ' gleich '],
    [/(?<![\p{L}\p{N}])_(?![\p{L}\p{N}])/gu, ' Unterstrich '],
    ['<', ' kleiner als '],
    ['>', ' größer als '],
    ['[', ' eckige Klammer auf '],
    [']', ' eckige Klammer zu '],
    ['@', ' At-Zeichen '],
    ['#', ' Rautezeichen '],
    ['^', ' Zirkumflex '],
    ['(', ' Klammer auf '],
    [')', ' Klammer zu '],
    [/(?<!\p{L})-(?!\p{L})/gu, ' Bindestrich '],
    ["'", ' Apostroph '],
  ] : [
    ['+', ' plus sign '],
    ['×', ' multiplication sign '],
    ['÷', ' divided by '],
    ['=', ' equals '],
    [/(?<![\p{L}\p{N}])_(?![\p{L}\p{N}])/gu, ' underscore '],
    ['<', ' less than '],
    ['>', ' greater than '],
    ['[', ' open square bracket '],
    [']', ' close square bracket '],
    ['@', ' at sign '],
    ['#', ' hash sign '],
    ['^', ' caret '],
    ['(', ' open parenthesis '],
    [')', ' close parenthesis '],
    [/(?<!\p{L})-(?!\p{L})/gu, ' hyphen '],
  ];
  for (const [symbol, spoken] of symbolNames) out=symbol instanceof RegExp ? out.replace(symbol,spoken) : out.split(symbol).join(spoken);
  out=out.replace(/\$/g,de?' Dollarzeichen ':' dollar sign ');
  out=out.replace(/\//g,de?' Schrägstrich ':' slash ');
  out=out.replace(/%/g,de?' Prozent ':' percent ');
  out=out.replace(/€/g,de?' Euro ':' euros ');
  out=out.replace(/&/g,de?' und ':' and ');
  out=out.replace(/\|/g,de?' senkrechter Strich ':' vertical bar ');
  if(de){
    out=out.replace(/(^|[^A-Za-z0-9:+-])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g,(_,prefix,h,m)=>`${prefix}${Number(h)} Uhr${Number(m)?' '+Number(m):''}`);
  }
  return out.replace(/\s+/g,' ').trim();
}

module.exports={normalizeSpeechSymbols,speechPlaceholders};
