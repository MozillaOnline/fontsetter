/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

(function() {
  const Cc = Components.classes;
  const Ci = Components.interfaces;
  const Cr = Components.results;
  const Cu = Components.utils;

  var strbundle;
  var fsDefaultFont;
  var fsLocale = Application.prefs.getValue("general.useragent.locale", "zh-CN");
  var jsm = {};
  Cu.import("resource://gre/modules/ctypes.jsm", jsm);
  Cu.import("resource://gre/modules/Services.jsm", jsm);

  function fontSetter_init() {
    strbundle = document.getElementById("fontsetterStrings");
    // Get default font setting for current locale.
    fsDefaultFont = strbundle.getString("fontsetter.defaultFont");
  }

  var ctypesClearTypeTuner = (function() {
    var _user32 = null;
    var _kernel32 = null;
    var _spi = null;
    var _gle = null;
    var _const = {
      SPIF_UPDATEINIFILE:       0x0001,
      SPIF_SENDCHANGE:          0x0002,
      SPI_GETFONTSMOOTHING:     0x004A,
      SPI_SETFONTSMOOTHING:     0x004B,
      SPI_GETFONTSMOOTHINGTYPE: 0x200A,
      SPI_SETFONTSMOOTHINGTYPE: 0x200B,
      FE_FONTSMOOTHINGSTANDARD: 0x0001,
      FE_FONTSMOOTHINGCLEARTYPE:0x0002,
    };
    var _fWinIni = _const.SPIF_UPDATEINIFILE | _const.SPIF_SENDCHANGE;

    var _init = function() {
      _user32 = jsm.ctypes.open("user32");
      _spi = _user32.declare("SystemParametersInfoW",
                              jsm.ctypes.winapi_abi,
                              jsm.ctypes.bool,
                              jsm.ctypes.unsigned_int,
                              jsm.ctypes.unsigned_int,
                              jsm.ctypes.voidptr_t,
                              jsm.ctypes.unsigned_int);
      _kernel32 = jsm.ctypes.open("kernel32");
      _gle = _kernel32.declare("GetLastError",
      jsm.ctypes.winapi_abi,
      jsm.ctypes.uint32_t)
    };

    var _close = function() {
      _user32.close();
      _kernel32.close()
    };

    var _error = function(msg) {
      Cu.reportError([msg, this._getLastError()].join(': '));
      _close();
      return false;
    };

    return {
      isClearTypeOn: function() {
        _init();
        var ret = jsm.ctypes.unsigned_int(0);
        if (!_spi(_const.SPI_GETFONTSMOOTHINGTYPE,
                  0,
                  ret.address(),
                  0)) {
          return _error('GETFONTSMOOTHINGTYPE')
        }
        _close();

        return ret.value == _const.FE_FONTSMOOTHINGCLEARTYPE
      },

      setClearTypeOn: function() {
        _init();
        var isSmooth = jsm.ctypes.bool(false);
        if (!_spi(_const.SPI_GETFONTSMOOTHING,
            0,
            isSmooth.address(),
            0)) {
          return _error('GETFONTSMOOTHING')
        }

        if (!isSmooth) {
          if (!_spi(_const.SPI_SETFONTSMOOTHING,
              1,            // TRUE
              jsm.ctypes.voidptr_t(0), // NULL
              _fWinIni)) {
            return _error('SETFONTSMOOTHING')
          }
        }

        if (!_spi(_const.SPI_SETFONTSMOOTHINGTYPE,
            0,
            jsm.ctypes.voidptr_t(_const.FE_FONTSMOOTHINGCLEARTYPE),
            _fWinIni)) {
          return _error('SETFONTSMOOTHINGTYPE_FONTSMOOTHINGCLEARTYPE')
        }

        _close();
      },

      setClearTypeOff: function() {
        _init();
        if (!_spi(_const.SPI_SETFONTSMOOTHINGTYPE,
            0,
            jsm.ctypes.voidptr_t(_const.FE_FONTSMOOTHINGSTANDARD),
            _fWinIni)) {
          return _error('SETFONTSMOOTHINGTYPE_FONTSMOOTHINGSTANDARD')
        }

        _close();
      }
    }
  })();

  function LOG(msg) {
    var debug = fontSetter_getPref('debug', false);
    if (!debug) {
      return;
    }

    try {
      var consoleService = Cc["@mozilla.org/consoleservice;1"]
                             .getService(Ci.nsIConsoleService);
      consoleService.logStringMessage(msg);
    } catch(e) {}
  }

  function fontSetter_setPref(prefName, value) {
    try {
      var prefs = Application.prefs;
      var name = "extensions.fontsetter@mozillaonline.com." + prefName;
      return prefs.setValue(name, value);
    } catch(e) {
      Cu.reportError(e);
    }

    return false;
  }

  function fontSetter_getPref(prefName, defValue) {
    try {
      var prefs = Application.prefs;
      var name = "extensions.fontsetter@mozillaonline.com." + prefName;
      return prefs.getValue(name, defValue);
    } catch (e) {
      Cu.reportError(e);
    }

    return null;
  }

  function fontsetter_appendFile(file, data) {
    // file is nsIFile, data is a string
    var foStream = Cc["@mozilla.org/network/file-output-stream;1"]
                     .createInstance(Ci.nsIFileOutputStream);

    // use 0x02 | 0x10 to open file for appending.
    foStream.init(file, 0x02 | 0x08 | 0x10, 0666, 0);
    // write, create, truncate
    // In a c file operation, we have no need to set file mode with or operation,
    // directly using "r" or "w" usually.
    foStream.write(data, data.length);
    foStream.close();
  }

  function fontsetter_readFile(file) {
    if (!file.exists())
      return;

    var data = "";
    var fstream = Cc["@mozilla.org/network/file-input-stream;1"]
                    .createInstance(Ci.nsIFileInputStream);
    var sstream = Cc["@mozilla.org/scriptableinputstream;1"]
                    .createInstance(Ci.nsIScriptableInputStream);
    fstream.init(file, -1, 0, 0);
    sstream.init(fstream);

    var str = sstream.read(4096);
    while (str.length > 0) {
      data += str;
      str = sstream.read(4096);
    }

    sstream.close();
    fstream.close();
    return data;
  }

  function fontsetter_getFile(fileName) {
    // get the path to the user's home (profile) directory
    try {
      var file = Cc["@mozilla.org/file/directory_service;1"]
                   .getService(Ci.nsIProperties)
                   .get("ProfD", Ci.nsIFile);
      file.append("chrome");
      if (!file.exists() || !file.isDirectory()) {
        file.create(Ci.nsIFile.DIRECTORY_TYPE, 0777);
      }

      file.append(fileName);

      return file;
    } catch (e) {
      Cu.reportError(e);
    }

    return null;
  }

  function fontsetter_setFont(fontName) {
    // 设为默认字体，所有3种
    fontsetter_setFontForWebpage(fontName);
    if (!fontSetter_getPref("use_default_menu_font", false)) {
      // 设置菜单字体
      fontsetter_setFontForBrowser(fontName);
      // 设置字体文件
      fontsetter_setFontForUserChrome(fontName);
    }
    // rebuild menu
    fontsetter_rebuildMenu();
  }

  function fontsetter_writeFile(file, data) {
    // file is nsIFile, data is a string
    var foStream = Cc["@mozilla.org/network/file-output-stream;1"]
                     .createInstance(Ci.nsIFileOutputStream);
    // use 0x02 | 0x10 to open file for appending.
    foStream.init(file, 0x02 | 0x08 | 0x20, 0666, 0);
    // write, create, truncate
    // In a c file operation, we have no need to set file mode with or operation,
    // directly using "r" or "w" usually.
    foStream.write(data, data.length);
    foStream.close();
  }

  function fontsetter_setFontForWebpage(fontName) {
    // 设为默认字体，所有3种，修改userChrome.css
    if (fontName == null || fontName == "") return;

    Application.prefs.setValue("font.name.monospace.zh-CN", fontName);
    Application.prefs.setValue("font.name.monospace.zh-HK", fontName);
    Application.prefs.setValue("font.name.monospace.zh-TW", fontName);
    Application.prefs.setValue("font.name.monospace.x-western", fontName);

    Application.prefs.setValue("font.name.sans-serif.zh-CN", fontName);
    Application.prefs.setValue("font.name.sans-serif.zh-HK", fontName);
    Application.prefs.setValue("font.name.sans-serif.zh-TW", fontName);
    Application.prefs.setValue("font.name.sans-serif.x-western", fontName);

    Application.prefs.setValue("font.name.serif.zh-CN", fontName);
    Application.prefs.setValue("font.name.serif.zh-HK", fontName);
    Application.prefs.setValue("font.name.serif.zh-TW", fontName);
    Application.prefs.setValue("font.name.serif.x-western", fontName);

    fontSetter_setPref("currentfont", fontName);
  }

  function fontsetter_resetPref(name) {
    if (name == null)
      return;

    try {
      var pref = Application.prefs.get(name);
      pref.reset();
    } catch (e) {
      LOG ("fontsetter : resetPref: " + name + ": exception: may be is already default: " + e.toString());
      Cu.reportError(e);
    }
  }

  function fontsetter_unsetFontForWebpage() {
    try {
      fontsetter_resetPref("font.name.monospace.zh-CN");
      fontsetter_resetPref("font.name.monospace.zh-HK");
      fontsetter_resetPref("font.name.monospace.zh-TW");
      fontsetter_resetPref("font.name.monospace.x-western");

      fontsetter_resetPref("font.name.sans-serif.zh-CN");
      fontsetter_resetPref("font.name.sans-serif.zh-HK");
      fontsetter_resetPref("font.name.sans-serif.zh-TW");
      fontsetter_resetPref("font.name.sans-serif.x-western");

      fontsetter_resetPref("font.name.serif.zh-CN");
      fontsetter_resetPref("font.name.serif.zh-HK");
      fontsetter_resetPref("font.name.serif.zh-TW");
      fontsetter_resetPref("font.name.serif.x-western");
    } catch (e) {
      LOG ("fontsetter : unsetFontForWebpage: exception" + e.toString());
      Cu.reportError(e);
    }
  }

  function fontsetter_setFontForUserChrome(fontName) {
    // 方法1:如果不存在fontsetter.css则在userChrome.css中加入import语句,否则直接替换fontsetter.css //此方法不成功
    // 方法2:在userChrome内加入fontsetter section,并每次修改fontsetter section
    if (fontName == null || fontName == "") return;
    var chromeFile = fontsetter_getFile("userChrome.css");
    if (!chromeFile.exists()) {
      fontsetter_writeFile(chromeFile, "@namespace url(\"http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul\");\n/*fontsetter section*/\n*{\n\tfont-family: " + fontName +";\n}\n/*end of fontsetter section*/");
    } else {
      // 其中是否有fontsetter的信息，有则replace，没有则添加
      var data = fontsetter_readFile(chromeFile);
      if (/\/\*fontsetter section\*\//.test(data)) {
        data = data.replace(/\/\*fontsetter section\*\/[^\\]*\/\*end of fontsetter section\*\//,"/*fontsetter section*/\n*{\n\tfont-family: " + fontName +";\n}\n/*end of fontsetter section*/");
        fontsetter_writeFile(chromeFile,data);
      } else {
        //检测是否有@namespace,没有加上
        if (!/@namespace.*there\.is\.only\.xul/.test(data)) {
          fontsetter_appendFile(chromeFile, "\n@namespace url(\"http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul\");\n/*fontsetter section*/\n*{\n\tfont-family: " + fontName +";\n}\n/*end of fontsetter section*/");
        } else {
          fontsetter_appendFile(chromeFile, "\n/*fontsetter section*/\n*{\n\tfont-family: " + fontName +";\n}\n/*end of fontsetter section*/");
        }
      }
    }
  }

  function fontsetter_unsetFontForUserChrome() {
    var chromeFile = fontsetter_getFile("userChrome.css");
    if (!chromeFile.exists()) {
      return;
    } else {
      //其中是否有fontsetter的信息，有则remove
      var data = fontsetter_readFile(chromeFile);
      if (/\/\*fontsetter section\*\//.test(data)) {
        data = data.replace(/\/\*fontsetter section\*\/[^\\]*\/\*end of fontsetter section\*\//,"");
        fontsetter_writeFile(chromeFile, data);
      }
    }
  }

  function fontsetter_getFontStyleSheet() {
    var styleSheet = null;
    for (var i = 0; i < window.document.styleSheets.length; i++) {
      if (window.document.styleSheets[i].href == "chrome://fontsetter/content/fontsetter-font.css") {
        styleSheet = window.document.styleSheets[i];
      }
    }
    return styleSheet;
  }

  function fontsetter_setFontForBrowser(fontName) {
    if (fontName == null || fontName == "") return;
    try {
      // 替换当前窗口的style
      var styleSheet = fontsetter_getFontStyleSheet();
      if (styleSheet == null) {
        LOG ("fontsetter : setFontForBrowser: exception: styleSheet not found");
        return;
      }

      while (styleSheet.cssRules.length != 0) {
        styleSheet.deleteRule(0);
      }

      styleSheet.insertRule("* {font-family: " + fontName +";}", styleSheet.cssRules.length);
    } catch (e) {
      LOG ("fontsetter : setFontForBrowser: exception");
      Cu.reportError(e);
    }
  }

  function fontsetter_unsetFontForBrowser() {
    // 方法1:如果不存在fontsetter.css则在userChrome.css中加入import语句,否则直接替换fontsetter.css //此方法不成功
    // 方法2:在userChrome内加入fontsetter section,并每次修改fontsetter section
    try {
      // 替换当前窗口的style
      var styleSheet = fontsetter_getFontStyleSheet();
      if (styleSheet == null) {
        LOG ("fontsetter : unsetFontForBrowser: exception: styleSheet not found");
        return;
      }

      while (styleSheet.cssRules.length != 0) {
        styleSheet.deleteRule(0);
      }
    } catch (e) {
      LOG ("fontsetter : setFontForBrowser: exception");
      Cu.reportError(e);
    }
  }

  function fontsetter_createMenuItem(fontName, index) {
    var item = document.createElement("menuitem");
    item.setAttribute("class", "menuitem-iconic");
    item.setAttribute("id", "fontsetter-menuitem-"+index);
    item.setAttribute("label", fontName);
    item.setAttribute("type", "checkbox");
    item.setAttribute("checked", (fontName == fontSetter_getPref("currentfont", "")));
    item.setAttribute("autocheck", "false");
    item.setAttribute("oncommand", "MOA.FontSetter.setFont(\""+ fontName+"\")");

    return item;
  }

  function fontsetter_switchFontForMenu() {
    try {
      fontSetter_setPref("use_default_menu_font", !fontSetter_getPref("use_default_menu_font", false));

      if (fontSetter_getPref("use_default_menu_font", false)) {
        fontsetter_unsetFontForBrowser();
        fontsetter_unsetFontForUserChrome();
      } else {
        var currentFont = fontSetter_getPref("currentfont", "");
        if (currentFont != "") {
//          fontSetter_setPref("use_default_menu_font", !fontSetter_getPref("use_default_menu_font", true));
          fontsetter_setFontForBrowser(currentFont);
          fontsetter_setFontForUserChrome(currentFont);
        }
      }

      fontsetter_rebuildMenu();
    } catch (e) {
      alert(e.toString());
    }
  }

  function fontsetter_switchShowAllFonts() {
    fontSetter_setPref("show_all_fonts", !fontSetter_getPref("show_all_fonts", false));
    fontsetter_rebuildMenu();
  }

  function fontsetter_switchClearType() {
    try {
      if (ctypesClearTypeTuner.isClearTypeOn()) {
        ctypesClearTypeTuner.setClearTypeOff();
      } else {
        ctypesClearTypeTuner.setClearTypeOn();
      }

      fontsetter_rebuildMenu();
    } catch (e) {
      LOG("fontsetter: switch clear type exception: " + e.toString());
      return;
    }
  }

  function fontsetter_rebuildMenu() {
    var menupopup = document.getElementById("fontsetter-selector-menu");
    if (menupopup == null) {
      LOG ("fontsetter: menu is not loaded yet");
      return;
    }

    //remove all children
    while (menupopup.firstChild) {
      menupopup.removeChild(menupopup.firstChild);
    }

    //add two button, 1. RestoreDefault 2.SetMenuFont 3.UseClearType
    var restore = document.createElement("menuitem");
    restore.setAttribute("class", "menuitem-iconic");
    restore.setAttribute("label", strbundle.getString("fontsetter.restoreDefault"));
    restore.setAttribute("oncommand", "MOA.FontSetter.restoreDefault()");
    menupopup.appendChild(restore);

    var setMenu = document.createElement("menuitem");
    setMenu.setAttribute("class", "menuitem-iconic");
    setMenu.setAttribute("label", strbundle.getString("fontsetter.applyToMenu"));
    setMenu.setAttribute("type", "checkbox");
    setMenu.setAttribute("checked", !fontSetter_getPref("use_default_menu_font", false));
    setMenu.setAttribute("autocheck", "false");
    setMenu.setAttribute("oncommand", "MOA.FontSetter.switchFontForMenu()");
    menupopup.appendChild(setMenu);

    try {
      if (navigator.appVersion.indexOf("Win") != -1) {
        var useClearType = document.createElement("menuitem");
        useClearType.setAttribute("class", "menuitem-iconic");
        useClearType.setAttribute("label", strbundle.getString("fontsetter.useClearType"));
        useClearType.setAttribute("type", "checkbox");
        useClearType.setAttribute("checked", ctypesClearTypeTuner.isClearTypeOn());
        useClearType.setAttribute("autocheck", "false");
        useClearType.setAttribute("oncommand", "MOA.FontSetter.switchClearType()");
        menupopup.appendChild(useClearType);
      }
    } catch (e) {
      LOG("fontsetter: get clear type exception: " + e.toString());
    }

    menupopup.appendChild(document.createElement("menuseparator"));

    // modify style sheet to make menuItem label apply the font
    var styleSheet = fontsetter_getFontStyleSheet();
    // add Fonts for Chinese first
    var enumerator = Cc["@mozilla.org/gfx/fontenumerator;1"]
                       .getService(Ci.nsIFontEnumerator);
    var mainFonts = enumerator.EnumerateFonts(fsLocale, "", { });
    var index = 0;
    if (mainFonts.length > 0) {
      for (var i = 0; i < mainFonts.length; ++i) {
        // check the font's name is Chinese or English
        if (mainFonts[i].charCodeAt(0) < 127) {
          continue;
        }

        // the following line is added for Lenovo font links... which sucks
        if (mainFonts[i].substr(mainFonts[i].length - 5) == "_boot") {
          continue;
        }

        var menuItem = fontsetter_createMenuItem(mainFonts[i], index);
        menupopup.appendChild(menuItem);
        try {
          if (styleSheet != null)
            styleSheet.insertRule("#fontsetter-menuitem-" + index +" > label {font-family: \"" + mainFonts[i] +"\" !important;}", styleSheet.cssRules.length);
          index++;
        } catch (e) {
          LOG("style for menuitem exception:" + e.toString());
        }
      }
      menupopup.appendChild(document.createElement("menuseparator"));
    }

    // 显示所有字体选项
    if (mainFonts.length >0) {
      var showAllFonts = document.createElement("menuitem");
      showAllFonts.setAttribute("class", "menuitem-iconic");
      showAllFonts.setAttribute("label", strbundle.getString("fontsetter.displayAllFonts"));
      showAllFonts.setAttribute("type", "checkbox");
      showAllFonts.setAttribute("checked", fontSetter_getPref("show_all_fonts", false));
      showAllFonts.setAttribute("autocheck", "false");
      showAllFonts.setAttribute("oncommand", "MOA.FontSetter.switchShowAllFonts()");
      menupopup.appendChild(showAllFonts);
    }

    // add all Fonts
    if (fontSetter_getPref("show_all_fonts", false) || mainFonts.length == 0) {
      if (mainFonts.length >0) {
        menupopup.appendChild(document.createElement("menuseparator"));
      }

      var localFontCount = { value: 0 }
      var localFonts = enumerator.EnumerateAllFonts(localFontCount);
      for (var i = 0; i < localFonts.length; ++i) {
        var menuItem = fontsetter_createMenuItem(localFonts[i], index);
        menupopup.appendChild(menuItem);
        try {
          if (styleSheet != null)
            styleSheet.insertRule("#fontsetter-menuitem-" + index +" > label {font-family: \"" + localFonts[i] +"\" !important;}", styleSheet.cssRules.length);
          index++;
        } catch (e) {
          LOG("style for menuitem exception:" + e.toString());
        }
      }
    }
  }

  function fontsetter_checkFirstRun() {
    var lastUIChange = fontSetter_getPref("lastUIChange", "0.0");
    if (lastUIChange >= "0.3") {
      return;
    }

    fontSetter_setPref("use_default_menu_font", false);
    var enumerator = Components.classes["@mozilla.org/gfx/fontenumerator;1"]
               .getService(Components.interfaces.nsIFontEnumerator);
    var localFontCount = { value: 0 };
    var localFonts = enumerator.EnumerateAllFonts(localFontCount);
    if (navigator.appVersion.indexOf("Win")!=-1) {
      try {
        if (fontSetter_getPref('restore_use_document_fonts', true)) {
          var currentFont = fontSetter_getPref("currentfont", "");
          fontsetter_resetPref("browser.display.use_document_fonts");
          fontsetter_setFont(currentFont);
        } else {
          for (var i = 0; i < localFonts.length; ++i) {
            if (localFonts[i] == fsDefaultFont) {
              fontsetter_setFont(fsDefaultFont);
              ctypesClearTypeTuner.setClearTypeOn();
            }
          }
        }
      } catch(e) {
        LOG("fontsetter: check first run: set clear type exception: " + e.toString());
        return;
      }
    }

    var addonbar = window.document.getElementById("addon-bar");
    let curSet = addonbar.currentSet;
    if (-1 == curSet.indexOf("tcfontsetter")) {
      let newSet = curSet + ",tcfontsetter";
      addonbar.currentSet = newSet;
      addonbar.setAttribute("currentset", newSet);
      document.persist(addonbar.id, "currentset");
      try {
        BrowserToolboxCustomizeDone(true);
      } catch(e) {}
    }

    if (addonbar.getAttribute("collapsed") == "true") {
      addonbar.setAttribute("collapsed", "false");
    }

    document.persist(addonbar.id, "collapsed");
    fontSetter_setPref("firstrun", false);
    fontSetter_setPref("lastUIChange", "0.3");
  }

  function fontsetter_restoreDefault() {
    fontSetter_setPref("currentfont", "");
    fontsetter_unsetFontForWebpage();
    fontsetter_unsetFontForBrowser();
    fontsetter_unsetFontForUserChrome();
    fontsetter_rebuildMenu();
  }

  function fontsetter_popupMenu() {
    var popup = document.getElementById("fontsetter-selector-menu");
    var panel;
    if (document.getElementById("fontsetter-statusbar"))
      panel = document.getElementById("fontsetter-statusbar");
    else
      panel = document.getElementById("tcfontsetter");
    popup.openPopup(panel, "after_start", 0, -3);
  }

  window.addEventListener("load", function(e) {
    window.setTimeout(function() {
      fontSetter_init();
      fontsetter_checkFirstRun();
      fontsetter_rebuildMenu();
    }, 50);
  }, false);

  var ns = MOA.ns('FontSetter');
  ns.popupMenu = fontsetter_popupMenu;
  ns.restoreDefault = fontsetter_restoreDefault;
  ns.switchClearType = fontsetter_switchClearType;
  ns.switchShowAllFonts = fontsetter_switchShowAllFonts;
  ns.switchFontForMenu = fontsetter_switchFontForMenu;
  ns.setFont = fontsetter_setFont;
})();

