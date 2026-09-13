const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {normalizeSpeechSymbols,speechPlaceholders}=require('../lib/tts_pronunciation');
const {detectTtsLanguage}=require('../lib/tts_language');

test('German money explicitly speaks the decimal separator and grammatical one',()=>{
 for(const [input,expected] of [
  ['0,37 $','null Komma drei sieben Dollar'],
  ['$0.37','null Komma drei sieben Dollar'],
  ['1 $','ein Dollar'],['€1','ein Euro'],['1 INR','eine indische Rupie'],
  ['-1 $','minus ein Dollar'],['0,037 $','null Komma null drei sieben Dollar'],
  ['1,01 $','eins Komma null eins Dollar'],['21 $','einundzwanzig Dollar'],
  ['1000000 €','eine Million Euro'],
 ]){
  assert.equal(normalizeSpeechSymbols(input,'de'),expected);
  assert.equal(normalizeSpeechSymbols(expected,'de'),expected);
 }
});

test('temperatures support negative/decimal Celsius, Fahrenheit, Kelvin and Unicode symbols',()=>{
 assert.equal(normalizeSpeechSymbols('−5,5 °C, +20℃, 68°F, 273.15 K und 5°','de'),
  'minus 5,5 Grad Celsius, plus 20 Grad Celsius, 68 Grad Fahrenheit, 273,15 Kelvin und 5 Grad');
 assert.equal(normalizeSpeechSymbols('-1°C, 2°F, 1 K','en'),
  'minus 1 degree Celsius, 2 degrees Fahrenheit, 1 Kelvin');
});
test('currency prefixes, suffixes, separators and singular forms are localized',()=>{
 assert.equal(normalizeSpeechSymbols('€1.234,50; GBP 1; 2 CHF; NT$500; 10 USD; 100 JPY; CNY 20; ₹5','de'),
  'eintausendzweihundertvierunddreißig Komma fünf null Euro; ein britisches Pfund; zwei Schweizer Franken; fünfhundert Taiwan-Dollar; zehn US-Dollar; einhundert japanische Yen; zwanzig chinesische Yuan; fünf indische Rupien');
 assert.equal(normalizeSpeechSymbols('EUR 1,234.50; £1; 2 GBP; CAD 5; AUD 1','en'),
  '1234.50 euros; 1 British pound; 2 British pounds; 5 Canadian dollars; 1 Australian dollar');
 assert.equal(normalizeSpeechSymbols('$Skill and USD_VALUE','en'),'dollar sign Skill and USD_VALUE');
});
test('physical units support powers, volume, metric prefixes and compound units',()=>{
 const input='2 m², 3 m^3, 4 dm, 5 cm³, 6 dm², 7 ml, 8 kg, 9 µm, 10 km/h, 9,81 m/s², 11 kWh';
 assert.equal(normalizeSpeechSymbols(input,'de'),
  '2 Quadratmeter, 3 Kubikmeter, 4 Dezimeter, 5 Kubikzentimeter, 6 Quadratdezimeter, 7 Milliliter, 8 Kilogramm, 9 Mikrometer, 10 Kilometer pro Stunde, 9,81 Meter pro Sekunde zum Quadrat, 11 Kilowattstunden');
 assert.equal(normalizeSpeechSymbols('1 m², 2 m³, 1 kg, 2 km/h','en'),
  '1 square meter, 2 cubic meters, 1 kilogram, 2 kilometers per hour');
 assert.equal(normalizeSpeechSymbols('1 mW, 2 MW, 3 MHz, 4 hPa, 5 kΩ','de'),
  '1 Milliwatt, 2 Megawatt, 3 Megahertz, 4 Hektopascal, 5 Kiloohm');
});
test('repeated normalization preserves amounts and avoids unit matches within identifiers',()=>{
 const text=normalizeSpeechSymbols('€1.234,50, 3 m³, −5°C, 1 h, 2 kWh','de');
 assert.equal(normalizeSpeechSymbols(text,'de'),text);
 assert.equal(normalizeSpeechSymbols('abc5m 3 model 5 mfoo USD_KEY','en'),'abc5m 3 model 5 mfoo USD_KEY');
});

test('German commands, skill prefixes and money retain their different meanings',()=>{
 assert.equal(normalizeSpeechSymbols('Bitte /app öffnen. $Skill kostet $5 oder 5 $.','de'),
  'Bitte Schrägstrich app öffnen. Dollarzeichen Skill kostet fünf Dollar oder fünf Dollar.');
 assert.equal(normalizeSpeechSymbols('$1.50, 20% & 30°C um 06:05','de'),
  'eins Komma fünf null Dollar, 20 Prozent und 30 Grad Celsius um 6 Uhr 5');
});
test('German TTS expands operator and bracket symbols into speakable words',()=>{
 assert.equal(normalizeSpeechSymbols("+×÷=/_<>[]@#€%^&*()-'",'de'),
  'Pluszeichen Malzeichen geteilt durch gleich Schrägstrich Unterstrich kleiner als größer als eckige Klammer auf eckige Klammer zu At-Zeichen Rautezeichen Euro Prozent Zirkumflex und Klammer auf Klammer zu Bindestrich Apostroph');
 assert.equal(normalizeSpeechSymbols('x=-5, y=+3, a-b','de'),
  'x gleich minus 5, y gleich plus 3, a-b');
});
test('English symbol names and amounts stay English; Chinese is left to its engine',()=>{
 assert.equal(normalizeSpeechSymbols('Use /help. $Skill costs $1 or $5.','en'),
  'Use slash help. dollar sign Skill costs 1 dollar or 5 dollars.');
 assert.equal(normalizeSpeechSymbols('你好 $5 /help','zh'),'你好 $5 /help');
});
test('URLs and paths do not turn into long sequences of spoken slashes',()=>{
 const result=normalizeSpeechSymbols('Hier: https://example.com/a und /home/daniel/a sowie C:\\Users\\test. Nutze /app.','de');
 assert.equal(result,'Hier: ein Link und ein Dateipfad sowie ein Dateipfad Nutze Schrägstrich app.');
 assert.equal(normalizeSpeechSymbols(result,'de'),result);
});
test('real bot pronunciation bypasses English clock and contraction rules for German',()=>{
 const source=fs.readFileSync(require.resolve('../bot.js'),'utf8');
 const context=vm.createContext({detectTtsLanguage,normalizeSpeechSymbols,speechPlaceholders,TTS_DEFAULT_LANGUAGE:'de',
  formatClockTimeForTts:()=> 'six o clock',integerToOrdinalWords:()=> 'first'});
 for(const [start,end] of [['function applyCommonTtsPronunciationFixes(text)', 'function splitVoiceReplyParts('],['function makeSpeakableTextForTts(text)', 'function makeWorldMonitorTextTtsFriendly(']]){
  const a=source.indexOf(start);vm.runInContext(source.slice(a,source.indexOf(end,a)),context);
 }
 assert.equal(context.applyCommonTtsPronunciationFixes('Bitte /app um 06:00 bei 20°C öffnen. $Skill kostet $5.'),
 'Bitte Schrägstrich app um 6 Uhr bei 20 Grad Celsius öffnen. Dollarzeichen Skill kostet fünf Dollar.');
 assert.match(context.applyCommonTtsPronunciationFixes("I'm ready at 06:00."),/I am ready at six o clock/);
 assert.equal(context.makeSpeakableTextForTts('Hier ist https://example.com/test und /home/daniel/file.'),'Hier ist ein Link und ein Dateipfad');
});
test('progress counters are spoken as completed of total, with commands and dates kept separate',()=>{
 assert.equal(normalizeSpeechSymbols('2/2 Pakete, 1 / 5 fertig, 0/12 offen.','de'),'zwei von zwei Pakete, eins von fünf fertig, null von zwölf offen.');
 assert.equal(normalizeSpeechSymbols('2/2 packages completed.','en'),'2 of 2 packages completed.');
 assert.equal(normalizeSpeechSymbols('/app: 2/2.','de'),'Schrägstrich app: zwei von zwei.');
 assert.doesNotMatch(normalizeSpeechSymbols('08/09/2026, 3,2/2,1, v2/2, 2/0','de'),/ von /);
});
