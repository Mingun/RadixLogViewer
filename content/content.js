var Log = {
  // Константы
  HTML_NS: 'http://www.w3.org/1999/xhtml',
  LOG_NS: "http://schemas.radixware.org/systemcommands.xsd",
  EVENT_CONVERTERS: {
    Severity: parseInt,
    RaiseTime: function(dateAsStr) { return new Date(dateAsStr); },
  },

  // Вызывается при загрузке XUL окна браузера
  onLoad: function(event) {
    // Если скрипт сработал по загрузке окна браузера, то подписываемя на окончание загрузки
    // содержимого. В противном случае это загрузилось содержимое.
    var appcontent = document.getElementById("appcontent"); // browser
    if (appcontent) {
      appcontent.addEventListener("DOMContentLoaded", this.onPageLoad, true);
    } else {
      this.onPageLoad(event);
    }
  },
  // Вызывается после полной загрузки страницы
  onPageLoad: function(event) {
    // Загруженный документ
    this.load(event.originalTarget);
  },
  load: function(doc) {
    var root = doc.getElementsByTagName("EventList");
    if (root.length == 0) {
      console.log('No EventList element');
      // Если это не трасса событий, то выходим
      return;
    }

    // Получаем список событий
    var events = this.convert(root[0].getElementsByTagName("Event"));
    // Удаляем XML-узлы из дерева
    root[0].remove();
    return this.createGrid("#log", events);
  },
  /// Преобразует список DOM-элементов с XML-узлами в JSON-массив для компонента таблицы.
  convert: function(events) {
    let self = this;
    return Array.prototype.map.call(events, (event, i) => {
      return Log.fillObject({
        id: i,// Уникальный id требуется для древовидного представления
        Message: self.getContent(event, "Message"),
        Words: self.decodeWords(self.getContent(event, "Words")),
        contexts: Array.prototype.map.call(event.getElementsByTagName("EventContext"), x => self.fillObject({}, x)),
      }, event, self.EVENT_CONVERTERS);
    });
  },
  createGrid: function(containerId, events) {
    var columns = [
      {id: "RaiseTime", name: "Timestamp", field: "raisetime"},
      {id: "Severity" , name: "Severity" , field: "severity"},
      {id: "Message"  , name: "Message"  , field: "Message", width: 1000},
    ];

    var options = {
      enableCellNavigation: true,
      enableColumnReorder: false,
      autoHeight: true,
      fullWidthRows: true,
    };

    return new Slick.Grid(containerId, events, columns, options);
  },
  getContent: function(node, tag) {
    var collection = node.getElementsByTagName(tag);
    if (collection.length == 0) {
      return null;
    }
    return collection[0].textContent;
  },
  fillObject: function(obj, node, converter) {
    var names = node.getAttributeNames();
    for (var i = 0; i < names.length; ++i) {
      var value = node.getAttribute(names[i]);
      var f = converter ? converter[names[i]] : null;
      obj[names[i]] = f ? f(value) : value;
    }
    return obj;
  },
  decodeWords: function(words) {
    if (!words) return [];
    // Если есть words, то это base64 кодированное значение, дешифруем его.
    words = atob(words);

    // Формат строки words:
    // count? ('[' len ']' data)|count|
    let count = parseInt(words)|0;
    let r = Array(count);
    for (let i = 0; i < count; ++i) {
      var s = words.indexOf('[', s+1);
      if (s < 0) break;
      var e = words.indexOf(']', s+1);
      var len = parseInt(words.substring(s+1, e));
      r[i] = words.substring(e+1, e+1+len);
    }
    return r;
  },
};

window.addEventListener("load", function(event) { Log.onLoad(event); }, false);