const fs = require('node:fs');
const path = require('node:path');

// 第 4 个元素是可选的表情插图(参考 languageguide.org 的图片式词卡;
// 用 emoji 而非外站图片:零资产、零版权风险,拿到授权图片后可换成 img 字段)。

// 整体场景图(languageguide 式):一章一张全景,词条按 [x%, y%] 落位成热点。
// 坐标是 800×600 viewBox 里目标物中心的百分比;学词视图据此摆脉冲标记。
const SCENES = {
  1: {
    image: '/images/game/scenes/school.svg?v=1',
    spots: {
      school: [35, 14], classroom: [22, 61], desk: [15, 67], chair: [23, 67],
      door: [35, 66], window: [21, 55], floor: [15, 74.5], wall: [5.5, 58],
      board: [12, 55], library: [12.6, 35], playground: [84, 73], gate: [96, 75],
      office: [27, 37], hall: [44, 62], stairs: [47, 72.5], garden: [73, 80],
      gym: [57, 61], lab: [42, 35], canteen: [57, 37], seat: [30, 69],
      shelf: [31, 57], clock: [47.5, 52], light: [34.7, 53], flag: [65.5, 4],
      bell: [43.7, 51], map: [26.6, 55], picture: [30.9, 54], corner: [6.5, 76],
      room: [39, 25], building: [8, 21],
    },
  },
  2: {
    image: '/images/game/scenes/stationery.svg?v=1',
    spots: {
      screen: [17, 15], card: [35, 14], phone: [47, 15], key: [57, 16],
      watch: [70, 15], bin: [84, 20], box: [94, 20],
      book: [18, 46], notebook: [36, 46], paper: [48, 46], folder: [61.5, 46],
      cup: [75, 45], towel: [90, 46],
      pencil: [15.5, 63.5], pen: [36.8, 64.5], marker: [58.5, 63.5], crayon: [76.5, 63], brush: [91.5, 62],
      ruler: [16.6, 74], eraser: [32.5, 74], sharpener: [42.5, 73.5], clip: [52, 74],
      scissors: [61.5, 72.5], glue: [70, 72.5], tape: [78, 73], stamp: [88, 72],
      bag: [13, 85], button: [29, 85], string: [42, 85],
      // bottle 场景内无对应物,退回照片词卡
    },
  },
  3: {
    image: '/images/game/scenes/numbers.svg?v=1',
    spots: {
      one: [17.5, 51], two: [25.5, 51], three: [33.5, 51], four: [41.5, 51],
      five: [49.5, 51], six: [57.5, 51], seven: [65.5, 51], eight: [73.5, 51],
      nine: [81.5, 51], ten: [90, 51],
      eleven: [15, 34.5], twelve: [31, 27.5], thirteen: [47.5, 22.5], fifteen: [61, 18],
      twenty: [80, 20], thirty: [86, 17], fifty: [92, 21],
      first: [8.6, 76], second: [17, 78], third: [25, 79],
      hundred: [42, 72], half: [59, 75], many: [77.5, 78], few: [93.5, 80],
      number: [37, 88], count: [18.5, 90],
    },
  },
  4: {
    image: '/images/game/scenes/colors.svg?v=1',
    spots: {
      circle: [12.8, 16], square: [23, 16], triangle: [35, 16],
      star: [11.5, 32], heart: [26, 33.5], line: [34, 30], dot: [40, 38], shape: [39, 41],
      red: [54.7, 26.7], orange: [54.7, 31.7], yellow: [54.7, 36.7],
      green: [54.7, 41.7], blue: [54.7, 46.7], purple: [54.7, 51.7],
      color: [77.5, 23], black: [75, 19.7], white: [79.5, 17.3], grey: [84, 18.7],
      gold: [74.5, 25.7], silver: [78.5, 28.3], pink: [83, 27], brown: [77, 22.7],
      bright: [76.7, 46.3], dark: [89, 47.5],
      big: [79, 66], small: [91, 68], long: [20, 56], short: [12.5, 61.5],
      round: [70, 86], flat: [89, 87.5],
    },
  },
  5: {
    image: '/images/game/scenes/actions.svg?v=1',
    spots: {
      math: [12, 12], english: [30, 12], music: [48, 12], art: [66, 12], science: [84, 12],
      read: [10.7, 37.5], write: [25.7, 36.7], draw: [41, 37.5],
      ask: [60.7, 33], answer: [77.7, 33], teach: [91.5, 35.5],
      stand: [8.2, 80], walk: [19.5, 80.8], run: [31.5, 79], jump: [44, 76],
      play: [59, 80], sing: [74.5, 76], dance: [87.5, 78],
      homework: [12.5, 95.5], spell: [84, 95],
    },
  },
  6: {
    image: '/images/game/scenes/town.svg?v=1',
    spots: {
      morning: [12.5, 20], afternoon: [37.5, 13.7], evening: [62.5, 23.3], night: [89, 18.3],
      time: [50, 31.3], hour: [57, 93.7], minute: [67.5, 93.7],
      today: [13, 47.5], month: [10, 55.7], week: [17, 55.7], year: [87.5, 43.3],
      teacher: [10, 71.5], student: [26.5, 74], boy: [36.5, 74], girl: [43.5, 74],
      friend: [40, 76.7], group: [63, 75], team: [85.7, 76.7],
      name: [13.5, 91.7], class: [36, 91.3],
    },
  },
};

const CHAPTERS = [
  {
    chapter: 1, part: 'head', theme: '学校场所',
    words: [
      ['school', '学校', '/skuːl/', '🏫'], ['classroom', '教室', '/ˈklɑːsruːm/', '🧑‍🏫'], ['desk', '课桌', '/desk/', '✍️'],
      ['chair', '椅子', '/tʃeə/', '🪑'], ['door', '门', '/dɔː/', '🚪'], ['window', '窗户', '/ˈwɪndəʊ/', '🪟'],
      ['floor', '地板', '/flɔː/', '🟫'], ['wall', '墙', '/wɔːl/', '🧱'], ['board', '黑板', '/bɔːd/', '🟩'],
      ['library', '图书馆', '/ˈlaɪbrəri/', '📚'], ['playground', '操场', '/ˈpleɪɡraʊnd/', '🛝'], ['gate', '大门', '/ɡeɪt/', '🚧'],
      ['office', '办公室', '/ˈɒfɪs/', '💼'], ['hall', '大厅', '/hɔːl/', '🏛️'], ['stairs', '楼梯', '/steəz/', '🪜'],
      ['garden', '花园', '/ˈɡɑːdn/', '🌷'], ['gym', '体育馆', '/dʒɪm/', '🏋️'], ['lab', '实验室', '/læb/', '🧪'],
      ['canteen', '食堂', '/kænˈtiːn/', '🍽️'], ['seat', '座位', '/siːt/', '💺'], ['shelf', '书架', '/ʃelf/', '🗄️'],
      ['clock', '时钟', '/klɒk/', '🕐'], ['light', '灯', '/laɪt/', '💡'], ['flag', '旗', '/flæɡ/', '🚩'],
      ['bell', '铃', '/bel/', '🔔'], ['map', '地图', '/mæp/', '🗺️'], ['picture', '图画', '/ˈpɪktʃə/', '🖼️'],
      ['corner', '角落', '/ˈkɔːnə/', '📐'], ['room', '房间', '/ruːm/', '🛏️'], ['building', '楼房', '/ˈbɪldɪŋ/', '🏢'],
    ],
  },
  {
    chapter: 2, part: 'body', theme: '文具与日常用品',
    words: [
      ['pen', '钢笔', '/pen/', '🖊️'], ['pencil', '铅笔', '/ˈpensl/', '✏️'], ['book', '书', '/bʊk/', '📖'],
      ['bag', '书包', '/bæɡ/', '🎒'], ['ruler', '尺子', '/ˈruːlə/', '📏'], ['eraser', '橡皮', '/ɪˈreɪzə/', '🩹'],
      ['crayon', '蜡笔', '/ˈkreɪən/', '🖍️'], ['brush', '画笔', '/brʌʃ/', '🖌️'], ['glue', '胶水', '/ɡluː/', '🧴'],
      ['tape', '胶带', '/teɪp/', '📼'], ['paper', '纸', '/ˈpeɪpə/', '📄'], ['notebook', '笔记本', '/ˈnəʊtbʊk/', '📓'],
      ['folder', '文件夹', '/ˈfəʊldə/', '📁'], ['sharpener', '卷笔刀', '/ˈʃɑːpnə/', '🔪'], ['marker', '记号笔', '/ˈmɑːkə/', '✒️'],
      ['scissors', '剪刀', '/ˈsɪzəz/', '✂️'], ['clip', '回形针', '/klɪp/', '📎'], ['stamp', '印章', '/stæmp/', '📮'],
      ['card', '卡片', '/kɑːd/', '🃏'], ['box', '盒子', '/bɒks/', '📦'], ['bottle', '瓶子', '/ˈbɒtl/', '🍼'],
      ['cup', '杯子', '/kʌp/', '🥤'], ['towel', '毛巾', '/ˈtaʊəl/', '🧻'], ['key', '钥匙', '/kiː/', '🔑'],
      ['watch', '手表', '/wɒtʃ/', '⌚'], ['phone', '手机', '/fəʊn/', '📱'], ['screen', '屏幕', '/skriːn/', '🖥️'],
      ['button', '按钮', '/ˈbʌtn/', '🔘'], ['string', '绳子', '/strɪŋ/', '🪢'], ['bin', '垃圾桶', '/bɪn/', '🗑️'],
    ],
  },
  {
    chapter: 3, part: 'armL', theme: '数字',
    words: [
      ['one', '一', '/wʌn/', '1️⃣'], ['two', '二', '/tuː/', '2️⃣'], ['three', '三', '/θriː/', '3️⃣'],
      ['four', '四', '/fɔː/', '4️⃣'], ['five', '五', '/faɪv/', '5️⃣'], ['six', '六', '/sɪks/', '6️⃣'],
      ['seven', '七', '/ˈsevn/', '7️⃣'], ['eight', '八', '/eɪt/', '8️⃣'], ['nine', '九', '/naɪn/', '9️⃣'],
      ['ten', '十', '/ten/', '🔟'], ['eleven', '十一', '/ɪˈlevn/', '11'], ['twelve', '十二', '/twelv/', '12'],
      ['thirteen', '十三', '/ˌθɜːˈtiːn/', '13'], ['fifteen', '十五', '/ˌfɪfˈtiːn/', '15'], ['twenty', '二十', '/ˈtwenti/', '20'],
      ['thirty', '三十', '/ˈθɜːti/', '30'], ['fifty', '五十', '/ˈfɪfti/', '50'], ['hundred', '百', '/ˈhʌndrəd/', '100'],
      ['first', '第一', '/fɜːst/', '1st'], ['second', '第二', '/ˈsekənd/', '2nd'], ['third', '第三', '/θɜːd/', '3rd'],
      ['half', '一半', '/hɑːf/', '½'], ['many', '许多', '/ˈmeni/', '👥'], ['few', '少数', '/fjuː/', '🤏'],
      ['more', '更多', '/mɔː/', '➕'], ['less', '更少', '/les/', '➖'], ['all', '全部', '/ɔːl/', '💯'],
      ['some', '一些', '/sʌm/', '🍕'], ['number', '数字', '/ˈnʌmbə/', '🔢'], ['count', '数数', '/kaʊnt/', '🧮'],
    ],
  },
  {
    chapter: 4, part: 'armR', theme: '颜色与形状',
    words: [
      ['red', '红色', '/red/', '🔴'], ['blue', '蓝色', '/bluː/', '🔵'], ['green', '绿色', '/ɡriːn/', '🟢'],
      ['yellow', '黄色', '/ˈjeləʊ/', '🟡'], ['orange', '橙色', '/ˈɒrɪndʒ/', '🟠'], ['purple', '紫色', '/ˈpɜːpl/', '🟣'],
      ['pink', '粉色', '/pɪŋk/', '🌸'], ['brown', '棕色', '/braʊn/', '🟤'], ['black', '黑色', '/blæk/', '⚫'],
      ['white', '白色', '/waɪt/', '⚪'], ['grey', '灰色', '/ɡreɪ/', '🌫️'], ['gold', '金色', '/ɡəʊld/', '🥇'],
      ['silver', '银色', '/ˈsɪlvə/', '🥈'], ['color', '颜色', '/ˈkʌlə/', '🎨'], ['bright', '明亮的', '/braɪt/', '✨'],
      ['dark', '深色的', '/dɑːk/', '🌑'], ['circle', '圆形', '/ˈsɜːkl/', '⭕'], ['square', '正方形', '/skweə/', '⬜'],
      ['triangle', '三角形', '/ˈtraɪæŋɡl/', '🔺'], ['star', '星形', '/stɑː/', '⭐'], ['heart', '心形', '/hɑːt/', '❤️'],
      ['line', '线', '/laɪn/', '〰️'], ['dot', '点', '/dɒt/', '⏺️'], ['shape', '形状', '/ʃeɪp/', '🔷'],
      ['big', '大的', '/bɪɡ/', '🐘'], ['small', '小的', '/smɔːl/', '🐭'], ['long', '长的', '/lɒŋ/', '🐍'],
      ['short', '短的', '/ʃɔːt/', '🐜'], ['round', '圆的', '/raʊnd/', '🏀'], ['flat', '平的', '/flæt/', '🥞'],
    ],
  },
  {
    chapter: 5, part: 'legL', theme: '课程与动作',
    words: [
      ['read', '读', '/riːd/', '📖'], ['write', '写', '/raɪt/', '✍️'], ['draw', '画', '/drɔː/', '✏️'],
      ['sing', '唱', '/sɪŋ/', '🎤'], ['dance', '跳舞', '/dɑːns/', '💃'], ['listen', '听', '/ˈlɪsn/', '👂'],
      ['speak', '说', '/spiːk/', '🗣️'], ['learn', '学', '/lɜːn/', '🎓'], ['teach', '教', '/tiːtʃ/', '🧑‍🏫'],
      ['study', '学习', '/ˈstʌdi/', '📚'], ['spell', '拼写', '/spel/', '🔤'], ['ask', '问', '/ɑːsk/', '🙋'],
      ['answer', '回答', '/ˈɑːnsə/', '💬'], ['open', '打开', '/ˈəʊpən/', '🔓'], ['close', '关上', '/kləʊz/', '🔒'],
      ['stand', '站', '/stænd/', '🧍'], ['sit', '坐', '/sɪt/', '🪑'], ['walk', '走', '/wɔːk/', '🚶'],
      ['run', '跑', '/rʌn/', '🏃'], ['jump', '跳', '/dʒʌmp/', '🦘'], ['play', '玩', '/pleɪ/', '⚽'],
      ['help', '帮助', '/help/', '🤝'], ['share', '分享', '/ʃeə/', '🤲'], ['math', '数学', '/mæθ/', '📐'],
      ['english', '英语', '/ˈɪŋɡlɪʃ/', '🇬🇧'], ['music', '音乐', '/ˈmjuːzɪk/', '🎵'], ['art', '美术', '/ɑːt/', '🎨'],
      ['science', '科学', '/ˈsaɪəns/', '🔬'], ['lesson', '课', '/ˈlesn/', '🛎️'], ['homework', '作业', '/ˈhəʊmwɜːk/', '📝'],
    ],
  },
  {
    chapter: 6, part: 'legR', theme: '人物与时间',
    words: [
      ['teacher', '老师', '/ˈtiːtʃə/', '🧑‍🏫'], ['student', '学生', '/ˈstjuːdnt/', '🧑‍🎓'], ['friend', '朋友', '/frend/', '👫'],
      ['boy', '男孩', '/bɔɪ/', '👦'], ['girl', '女孩', '/ɡɜːl/', '👧'], ['class', '班级', '/klɑːs/', '🏫'],
      ['group', '小组', '/ɡruːp/', '👥'], ['team', '团队', '/tiːm/', '⚽'], ['name', '名字', '/neɪm/', '📛'],
      ['morning', '早上', '/ˈmɔːnɪŋ/', '🌅'], ['afternoon', '下午', '/ˌɑːftəˈnuːn/', '☀️'], ['evening', '傍晚', '/ˈiːvnɪŋ/', '🌆'],
      ['night', '夜晚', '/naɪt/', '🌙'], ['today', '今天', '/təˈdeɪ/', '📅'], ['tomorrow', '明天', '/təˈmɒrəʊ/', '🌄'],
      ['yesterday', '昨天', '/ˈjestədeɪ/', '🌃'], ['week', '星期', '/wiːk/', '🗓️'], ['month', '月', '/mʌnθ/', '📆'],
      ['year', '年', '/jɪə/', '🎆'], ['day', '天', '/deɪ/', '🌤️'], ['time', '时间', '/taɪm/', '⏰'],
      ['hour', '小时', '/ˈaʊə/', '⏳'], ['minute', '分钟', '/ˈmɪnɪt/', '⏱️'], ['early', '早的', '/ˈɜːli/', '🐓'],
      ['late', '晚的', '/leɪt/', '🦉'], ['now', '现在', '/naʊ/', '👇'], ['soon', '很快', '/suːn/', '🔜'],
      ['again', '再次', '/əˈɡen/', '🔁'], ['always', '总是', '/ˈɔːlweɪz/', '♾️'], ['never', '从不', '/ˈnevə/', '🚫'],
    ],
  },
];

const pack = {
  id: 'max',
  name: '校园小子 Max',
  themeColor: 'oklch(70% 0.19 45)',
  chapters: CHAPTERS.map(function (chapter) {
    const scene = SCENES[chapter.chapter] || null;
    return {
      chapter: chapter.chapter,
      part: chapter.part,
      theme: chapter.theme,
      scene: scene ? scene.image : undefined,
      words: chapter.words.map(function (entry) {
        const word = { lemma: entry[0], zh: entry[1], ipa: entry[2] };
        if (entry[3]) word.emoji = entry[3];
        if (scene && scene.spots[entry[0]]) word.spot = scene.spots[entry[0]];
        return word;
      }),
    };
  }),
};

const outPath = path.resolve(__dirname, '../../frontend/js/game/word-packs/pack-max.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(pack, null, 2) + '\n');
console.log('Wrote', outPath, '-', pack.chapters.reduce((s, c) => s + c.words.length, 0), 'words');
