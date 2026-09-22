/**
 * 为外向 **项目外** 8082 接收程序（非本仓库）的 `POST /__push/glass_session` 提供每曲 `smiles` 等组包数据。
 * 点歌并点「播放」时，本页在原有自动演奏之外会 `fetch` 发送该 JSON；规范与校验均由对方服务负责。
 * 仅当此处为对应曲目配置了非空 `smiles` 时才发送；未配置则不请求。
 */
window.SONG_GLASS_META = {
  浙大校歌: { smiles: "CCO", bpm: 100, reveal_last_sec: 5 },
  小星星_Twinkle_Twinkle: { smiles: "C", bpm: 100, reveal_last_sec: 5 },
  两只老虎_Two_Tigers: { smiles: "CC(C)O", bpm: 100, reveal_last_sec: 5 },
  生日快乐_Happy_Birthday: { smiles: "c1ccccc1", bpm: 100, reveal_last_sec: 5 },
  玛丽有只小羊羔_Mary_Had_a_Little_Lamb: { smiles: "CC(=O)O", bpm: 100, reveal_last_sec: 5 },
  划船歌_Row_Row_Row_Your_Boat: { smiles: "CCCC", bpm: 100, reveal_last_sec: 5 },
  伦敦桥_London_Bridge: { smiles: "CCN", bpm: 100, reveal_last_sec: 5 },
  小蜜蜂: { smiles: "CCCCCC", bpm: 100, reveal_last_sec: 5 },
  铃儿响叮当_Jingle_Bells: { smiles: "CC(C)C", bpm: 100, reveal_last_sec: 5 },
};
