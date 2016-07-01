'use strict';
let {classes: Cc, interfaces: Ci, results: Cr, Constructor: CC, utils: Cu} = Components;

Cu.import('resource://gre/modules/Services.jsm');
Cu.import("resource://gre/modules/Console.jsm");

let BinaryInputStream = CC('@mozilla.org/binaryinputstream;1', Ci.nsIBinaryInputStream, 'setInputStream');
let BinaryOutputStream = CC('@mozilla.org/binaryoutputstream;1', Ci.nsIBinaryOutputStream, 'setOutputStream');
let StorageStream = CC('@mozilla.org/storagestream;1', Ci.nsIStorageStream, 'init');

let SAXParser = CC('@mozilla.org/saxparser/xmlreader;1', Ci.nsISAXXMLReader);
let DOMParser = CC('@mozilla.org/xmlextras/domparser;1', Ci.nsIDOMParser);
let DOMSerializer = CC('@mozilla.org/xmlextras/xmlserializer;1', Ci.nsIDOMSerializer);

const STATE_UNKNOWN = 0;
const STATE_OWN     = 1;
const STATE_NOT_OWN = 2;

const LOG_NS      = "http://schemas.radixware.org/systemcommands.xsd";
const ROOT_NAME   = "EventList";
const ROOT_NAME_RE= new RegExp('^'+ROOT_NAME+'$', 'i');
const LAYOUT_PATH = "chrome://radixlogviewer/content/layout.xhtml";

function StopParseException(ownDoc) {
  this.ownDoc = ownDoc;
  this.stack = new Error().stack;
}
StopParseException.prototype.toString = function() {
  return 'StopParseException: stack:\n'+this.stack;
}
function RW_Converter(channel) {
  // Начинаем слушать данные из канала
  channel.QueryInterface(Ci.nsITraceableChannel);
  this._listener = channel.setNewListener(this);

  // Создаем парсер, готовый к асинхронному разбору поступающих порций данных
  this._parser = new SAXParser();
  this._parser.contentHandler = this;
  this._parser.errorHandler = this;
  this._parser.parseAsync(this);

  this.wrappedJSObject = this;
}
// Алгоритм работы:
// Подключаемся к каналу и слушаем входящие данные, отрезая от них исходный слушатель.
// Эти данные накапливаем и параллельно передаем асинхронному SAX-парсеру. Парсер ждет
// корневой элемент, и как только встречает его, прекращает разбор. В зависимости от
// того, является ли корневой документ нашими ожидаемыми данными или нет, предпринимаются
// следующие действия:
// 1) Если документ наш, то продолжаем накапливать данные, пока они не закончатся, а в конце
//    отдаем в исходный слушатель вместо загружаемого XML наш HTML layout, с вставленным в него
//    XML-ем.
// 2) В противном случае доставляем в исходный слушатель все накопленные данные и отключаемся
//    от канала и восстанавливаем исходный слушатель.
RW_Converter.prototype = {
  observe: function(aSubject, aTopic, aData) {
    let p = new RW_Converter(aSubject);
  },

  //{ nsISupports
  // Кастует наш объект к запрашиваемым интерфейсам а также определяет,
  // какие интерфейсы вообще им поддерживаются.
  QueryInterface: function(iid) {
    if (iid.equals(Ci.nsISupports)
     || iid.equals(Ci.nsISAXContentHandler)
     || iid.equals(Ci.nsISAXErrorHandler)
     || iid.equals(Ci.nsIRequestObserver)
     || iid.equals(Ci.nsIStreamListener)
    ) {
      return this;
    }
    throw Cr.NS_ERROR_NO_INTERFACE;
  },
  //}

  //{ nsISAXContentHandler
  startDocument: function() {},
  endDocument: function() {
    // Если разбор документа завершился и мы там и не сменили состояние,
    // значит это явно не наш документ. Требуется явная обработка, потому что
    // попытка передачи в парсер данные, когда он вызвал endDocument, завершается
    // ошибкой. Однако документ почему-то завершается для JS-скриптов
    if (this._state === STATE_UNKNOWN) {
      this._state = STATE_NOT_OWN;
    }
  },

  startElement: function(ns, localName, qName, /*nsISAXAttributes*/ attributes) {
    if (this._state === STATE_UNKNOWN) {
      let ownDoc = LOG_NS === ns && ROOT_NAME_RE.test(localName);
      // Прерываем дальнейший разбор
      this._state = ownDoc ? STATE_OWN : STATE_NOT_OWN;
    }
  },

  endElement: function(ns, localName, qName) {},
  characters: function(value) {},
  processingInstruction: function(target, data) {},
  ignorableWhitespace: function(whitespace) {},
  startPrefixMapping: function(prefix, uri) {},
  endPrefixMapping: function(prefix) {},
  //} nsISAXContentHandler
  //{ nsISAXErrorHandler
  error: function(locator, error) {},
  fatalError: function(locator, error) {
    // Если документ с ошибками, то мы его обработать все равно не сможем,
    // поэтому останавливаем разбор, считая, что документ не наш.
    this._state = STATE_NOT_OWN;
  },
  ignorableWarning: function(locator, error) {},
  //} nsISAXErrorHandler

  //{ nsIRequestObserver
  onStartRequest: function(aRequest, aContext) {
    // Данные, еще не доставленные в оригинальный слушатель
    this._chunks = [];
    // Общая длина еще не доставленный в оригинальный слушатель данных
    this._undeliveredLen = 0;

    this._state = STATE_UNKNOWN;

    this._parser.onStartRequest(aRequest, aContext);
    this._listener.onStartRequest(aRequest, aContext);
  },
  onStopRequest: function(aRequest, aContext, aStatusCode) {
    this._parser.onStopRequest(aRequest, aContext, aStatusCode);
    if (this._state === STATE_OWN) {
      // Это наш документ. Меняем его на разметку, внедряем в нее исходный документ и отдаем
      let storage = new StorageStream(8192, 0xFFFFFFFF, null);
      let doc = this._detachToNewHtmlDoc();
      let s = new DOMSerializer();
      s.serializeToStream(doc, storage.getOutputStream(0), 'UTF-8');

      this._listener.onDataAvailable(aRequest, aContext, storage.newInputStream(0), 0, storage.length);
    } else
    if (this._state === STATE_UNKNOWN) {
      // Состояние все еще неизвестно. Это может означать, что это вовсе не XML.
      // В любом случае, мы ничего сделать с этим не сможем, поэтому отдаем
      // нижележащему слушателю все накопленные данные.
      this._deliver(aRequest, aContext);
    }
    // В случае, если документ не наш, мы уже отдали все накопленные данные, как
    // только это обнаружили, поэтому сейчас просто передаем API вызов дальше
    this._listener.onStopRequest(aRequest, aContext, aStatusCode);
  },
  //} nsIRequestObserver
  //{ nsIStreamListener
  onDataAvailable: function(aRequest, aContext, aInputStream, aOffset, aCount) {
    // Если уже известно, что документ не наш, просто передаем все вышележащему
    // слушателю. Мы не можем отключится от канала, чтобы вовсе не получать уведомлений,
    // т.к. поверх нас может находиться другой слушатель
    if (this._state === STATE_NOT_OWN) {
      this._listener.onDataAvailable(aRequest, aContext, aInputStream, aOffset, aCount);
      return;
    }
    // Вычитываем и сохраняем данные для дальнейшего использования, а также, если
    // состояние еще неизвестно, перекладываем их в другой поток, чтобы отдать SAX-парсеру.
    let storage = this._consume(aInputStream, aCount, this._state === STATE_UNKNOWN);

    // Если мы еще не знаем, наш это документ или нет, то пытаемся это выяснить
    if (this._state === STATE_UNKNOWN) {
      this._parser.onDataAvailable(aRequest, aContext, storage.newInputStream(0), 0, storage.length);
    }
    // Если не наш документ, отдаем обернутому слушателю все еще не переданные
    // данные и отключаемся. Больше в этом состоянии он вызываться не будет
    if (this._state === STATE_NOT_OWN) {
      this._deliver(aRequest, aContext);
    }
    // В противном случае делать ничего не нужно -- данные просто будут накапливаться.
  },
  //} nsIStreamListener

  //{ Вспомогательные методы
  _consume: function(aInputStream, aCount, needCopy) {
    let iStream = new BinaryInputStream(aInputStream);

    // Вычитываем данные и сохраняем для дальнейшей обработки
    let chunk = iStream.readBytes(aCount);
    this._chunks.push(chunk);
    this._undeliveredLen += chunk.length;

    if (needCopy) {
      // Дублируем данные, чтобы их мог поглотить SAX-парсер
      let storage = new StorageStream(8192, chunk.length, null);
      let oStream = new BinaryOutputStream(storage.getOutputStream(0));
      oStream.writeBytes(chunk, chunk.length);

      return storage;
    }
    return null;
  },
  /// Передает все накопленные данные исходному слушателю и устанавливает его
  _deliver: function(aRequest, aContext) {
    let storage = this._detachToStream();

    this._listener.onDataAvailable(aRequest, aContext, storage.newInputStream(0), 0, storage.length);
  },
  _detachToNewHtmlDoc: function() {
    let doc = this._detachToXmlDoc();
    let layout = this._loadResource(LAYOUT_PATH);
    let events = doc.getElementsByTagNameNS(LOG_NS, ROOT_NAME);

    // Переносим корневой узел XML-документа в xHTML-документ разметки
    // и переносим в новый документ.
    let root = layout.adoptNode(events[0]);
    layout.documentElement.appendChild(root);
    // layout.getElementsById('log').appendChild(root);
    return layout;
  },
  /// Преобразует накопленные данные в XML-документ, удаляя сам массив с накопленными данными.
  _detachToXmlDoc: function() {
    let storage = this._detachToStream();
    let p = new DOMParser();
    return p.parseFromStream(storage.newInputStream(0), null, storage.length, "text/xml");
  },
  /// Преобразует накопленные данные в nsIStorageStream, удаляя сам массив с накопленными данными.
  _detachToStream: function() {
    let storage = new StorageStream(8192, this._undeliveredLen, null);
    let oStream = new BinaryOutputStream(storage.getOutputStream(0));
    for (let chunk of this._chunks) {
      oStream.writeBytes(chunk, chunk.length);
    }
    delete this._chunks;
    delete this._undeliveredLen;
    return storage;
  },
  /// Загружает файл с ресурсом по указанному пути.
  _loadResource: function(path) {
    let XHR = new XMLHttpRequest();
    // Настраиваем синхронное получение документа с разметкой будущей страницы
    XHR.open("GET", path, false);
    // Гарантируем, что содержимое загрузиться, как XML
    XHR.overrideMimeType("text/xml");
    // Инициируем загрузку. Т.к. она синхронная, этот метод блокируется до полной загрузки документа
    XHR.send(null);
    // Получаем разметку
    return XHR.responseXML;
  },
  //} Вспомогательные методы
};

Services.obs.addObserver(RW_Converter.prototype, 'http-on-examine-response', false);
Services.obs.addObserver(RW_Converter.prototype, 'http-on-examine-cached-response', false);
Services.obs.addObserver(RW_Converter.prototype, 'http-on-examine-merged-response', false);