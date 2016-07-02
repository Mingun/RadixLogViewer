'use strict';
let RW_Converter = (function() {
  let {classes: Cc, interfaces: Ci, results: Cr, Constructor: CC, utils: Cu} = Components;

  Cu.import("resource://gre/modules/XPCOMUtils.jsm");
  Cu.import("resource://gre/modules/Console.jsm");

  let BinaryInputStream = CC('@mozilla.org/binaryinputstream;1', Ci.nsIBinaryInputStream, 'setInputStream');
  let BinaryOutputStream = CC('@mozilla.org/binaryoutputstream;1', Ci.nsIBinaryOutputStream, 'setOutputStream');
  let StorageStream = CC('@mozilla.org/storagestream;1', Ci.nsIStorageStream, 'init');

  let SAXParser = CC('@mozilla.org/saxparser/xmlreader;1', Ci.nsISAXXMLReader);
  let DOMParser = CC('@mozilla.org/xmlextras/domparser;1', Ci.nsIDOMParser);
  let DOMSerializer = CC('@mozilla.org/xmlextras/xmlserializer;1', Ci.nsIDOMSerializer);
  let XMLHttpRequest= CC('@mozilla.org/xmlextras/xmlhttprequest;1', Ci.nsIXMLHttpRequest);
  // let ScriptableUnicodeConverter = CC("@mozilla.org/intl/scriptableunicodeconverter", Ci.nsIScriptableUnicodeConverter);

  const STATE_UNKNOWN = 0;
  const STATE_OWN     = 1;
  const STATE_NOT_OWN = 2;

  const LOG_NS      = "http://schemas.radixware.org/systemcommands.xsd";
  const ROOT_NAME   = "EventList";
  const ROOT_NAME_RE= new RegExp('^'+ROOT_NAME+'$', 'i');
  const LAYOUT_PATH = "chrome://radixlogviewer/content/layout.xhtml";
  // const MIME_TYPE   = "application/radixlog";
  const MIME_TYPE   = "application/radixlog";

  function Parser() {
    this._parser = new SAXParser();
    this._parser.contentHandler = this;
    this._parser.errorHandler = this;
  }
  Parser.prototype = {
    parse: function(data) {
      let storage = new StorageStream(8192, data.length, null);
      let oStream = new BinaryOutputStream(storage.getOutputStream(0));

      oStream.writeByteArray(data, data.length);

      this._state = STATE_UNKNOWN;
      this._parser.parseFromStream(storage.newInputStream(0), null, 'text/xml');
      return this._state === STATE_OWN;
    },
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
      // Не обрабатываем ошибки, т.к. документ может быть загружен не полностью,
      // и, как следствие, быть невалидным.
    },
    ignorableWarning: function(locator, error) {},
    //} nsISAXErrorHandler
  };

  function RW_Converter() {
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
    classDescription: "RadixWare Log Viewer XPCOM Component",
    classID: Components.ID("{05ae4c83-8abc-4375-9d2e-899c8e1385cb}"),
    // Конвертор из нашего собственного типа в любой другой
    contractID: "@mozilla.org/streamconv;1" + "?from=" + MIME_TYPE + "&to=*/*",

    _xpcom_categories: [
      { category: "@mozilla.org/streamconv;1",
        entry: "?from=" + MIME_TYPE + "&to=*/*",
        value: "RadixLog to HTML stream converter"
      },
      { category: "net-content-sniffers" }
    ],

    //{ nsIContentSniffer
    getMIMETypeFromContent: function(request, data) {
      if (new Parser().parse(data)) {
        request.QueryInterface(Ci.nsIChannel);
        console.log('Determine type:', MIME_TYPE, request.URI.spec);
        return MIME_TYPE;
      }
      return null;
    },
    //} nsIContentSniffer

    //{ nsISupports
    // Кастует наш объект к запрашиваемым интерфейсам а также определяет,
    // какие интерфейсы вообще им поддерживаются.
    QueryInterface: XPCOMUtils.generateQI([
        Ci.nsISupports,
        Ci.nsIContentSniffer,
        Ci.nsIStreamConverter,
        Ci.nsIRequestObserver,
        Ci.nsIStreamListener,
    ]),
    //}

    //{ nsIStreamConverter
    // Данный метод устарел и более не используется
    convert: function(fromStream, fromType, toType, aContext) { return fromStream; },

    asyncConvertData: function(fromType, toType, listener, aContext) {
      this._isOwn = fromType === MIME_TYPE;
      this._listener = listener;
    },
    //} nsIStreamConverter

    //{ nsIRequestObserver
    onStartRequest: function(aRequest, aContext) {
      // Данные, еще не доставленные в оригинальный слушатель
      this._chunks = [];
      // Общая длина еще не доставленных в оригинальный слушатель данных
      this._undeliveredLen = 0;

      // Заменяем каналу тип содержимого с $MIME_TYPE на xhtml для двух целей:
      // 1) Если этого не сделать, то возникнет рекурсия, т.к. Firefox пойдет искать обработчик для
      //    типа $MIME_TYPE и опять наткнется на нас.
      // 2) Чтобы в браузере использовался HTML-документ, а не XML документ, с которым jQuery работать
      //    не может, т.к. в XML документе нет многих свойств.
      aRequest.QueryInterface(Ci.nsIChannel);
      aRequest.contentType = "application/xhtml+xml";
      this._listener.onStartRequest(aRequest, aContext);
    },
    onStopRequest: function(aRequest, aContext, aStatusCode) {
      if (this._isOwn) {
        // Это наш документ. Меняем его на разметку, внедряем в нее исходный документ и отдаем
        let storage = new StorageStream(8192, 0xFFFFFFFF, null);
        let doc = this._detachToNewHtmlDoc();
        let s = new DOMSerializer();
        s.serializeToStream(doc, storage.getOutputStream(0), 'UTF-8');

        // Доставляем подмененный документ в исходный слушатель
        this._listener.onDataAvailable(aRequest, aContext, storage.newInputStream(0), 0, storage.length);
      }
      // В случае, если документ не наш, мы уже отдали все накопленные данные, как
      // только это обнаружили, поэтому сейчас просто передаем API вызов дальше
      this._listener.onStopRequest(aRequest, aContext, aStatusCode);
    },
    //} nsIRequestObserver
    //{ nsIStreamListener
    onDataAvailable: function(aRequest, aContext, aInputStream, aOffset, aCount) {
      // Если документ не наш, просто передаем все вышележащему слушателю.
      // Мы не можем отключится от канала, чтобы вовсе не получать уведомлений,
      // т.к. поверх нас может находиться другой слушатель
      if (this._isOwn) {
        // Вычитываем и сохраняем данные для дальнейшего использования
        this._consume(aInputStream, aCount);
      } else {
        this._listener.onDataAvailable(aRequest, aContext, aInputStream, aOffset, aCount);
      }
    },
    //} nsIStreamListener

    //{ Вспомогательные методы
    _consume: function(aInputStream, aCount) {
      let iStream = new BinaryInputStream(aInputStream);

      // Вычитываем данные и сохраняем для дальнейшей обработки
      let chunk = iStream.readBytes(aCount);
      this._chunks.push(chunk);
      this._undeliveredLen += chunk.length;
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
  return RW_Converter;
})();
if (XPCOMUtils.generateNSGetFactory) {// Firefox 4+
  var NSGetFactory = XPCOMUtils.generateNSGetFactory([RW_Converter]);
} else {// others
  var NSGetModule  = XPCOMUtils.generateNSGetModule([RW_Converter]);
}