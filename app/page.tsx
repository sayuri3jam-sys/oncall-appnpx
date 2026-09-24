'use client';

import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import kuromoji from 'kuromoji';

// ==========================================
// 1. 型定義
// ==========================================
// 📦 物品の「使用予定日」1件分。日にちが経過（今日を迎える）すると自動的に定数・在庫を1ずつ減らし、
// appliedをtrueにする（appliedになった後は日付を打ち消し線で表示し、履歴として残す）
interface SupplyScheduledUseEntry {
  date: string; // YYYY-MM-DD
  applied: boolean;
}
interface SupplyItem {
  id: string;
  name: string;
  allocated: number; // 定数（今月分の残り数。使用予定日の消化で減り、月初め1日に自動でbaseAllocatedへ戻る）
  baseAllocated: number; // 定数の基準値（毎月1日にallocatedをこの数へリセットする。定数を書き換えると一緒に更新される）
  lastResetMonth: string; // 定数を最後にリセットした月（YYYY-MM）。ログイン時に今月とズレていればリセットする
  stock: number; // 在庫（定数から独立して手動でも書き換えられる。月次リセットの対象外）
  unit: '個' | '箱'; // 定数・在庫の単位（個数か、箱単位か）
  kind: '定数' | '臨時'; // 常備している定数管理の物品か、今回だけの臨時追加か
  memo: string; // 物品名の下に記載するメモ（用途：必要定数変更・追加調達依頼内容など）
  scheduledUseDates: SupplyScheduledUseEntry[]; // 使用予定日（複数選択可。日の浅い順に表示する）
  recurringPattern?: { weekday: number; intervalDays: number }; // 曜日×間隔（2週間おき／30日おき）で
  // 使用予定日を選んだ時に記録するパターン。「翌月に進む」で新しい月の使用予定日を自動生成する時に使う
}

// 📦 物品管理「翌月に進む」でひと月分を履歴として保存するスナップショット（1か月分）。
// 部屋番号・氏名も一緒に保存しておくことで、後で部屋の入居者が変わっても当時の記録のまま見られる
interface SupplyMonthlySnapshot {
  patients: { patientId: string; room: string; name: string; supplies: SupplyItem[] }[];
  commonSupplies: SupplyItem[];
  // 🕒 最初に作成・保存された時刻（HH:mm）。臨時履歴の並び順・表示はこの「作成日時」を基準にし、
  //    後から「追加修正」で上書き保存しても変わらない
  savedAt?: string;
  // 🕒 最後に更新（追加修正して上書き保存）された日付・時刻（例："09/19 15:32"）。作成後に一度も
  //    追加修正されていなければ未設定（undefined）のまま
  updatedAt?: string;
}

// 📦 物品管理の「共通物品」（特定の入居者・部屋番号に紐づかない、施設共通の物品）を表す特別なID。
// 通常の入居者IDとは別の値になるよう、患者データには絶対に使われない形にしている
const COMMON_SUPPLY_ID = '__common_supply__';

// 🚨 緊急時対応サマリーシート用の型
interface KeyPerson {
  id: string;
  name: string;      // 氏名
  relation: string;  // 続柄
  tel1: string;      // TEL①
  tel2: string;      // 携帯②
  postalCode: string; // 郵便番号（数字7桁。入力完了すると住所欄に都道府県～市区町村を自動入力する）
  address: string;   // 住所
}

interface MedicationDetail {
  id: string;
  name: string;         // 薬剤名
  dosageTiming: string; // 用量・タイミング（例：朝食後 1錠）
}

interface ContraindicatedMedication {
  id: string;
  name: string; // 禁忌薬（絶対に避ける薬剤）の薬剤名
}

interface InfectionStatusItem {
  id: string;
  text: string; // 感染症名など（例：HCV、HBV）
}

// 🩺 「かかりつけ医」「救急搬送希望先」の入力履歴1件分。履歴一覧のその場で編集・削除できるよう、
// 内容の一致ではなくidで1件を特定できるようにしている
interface PrimaryDoctorHistoryEntry {
  id: string;
  clinic: string;
  name: string;
  postalCode: string;
  address: string;
  tel: string;
}
interface EmergencyHospitalHistoryEntry {
  id: string;
  name: string;
  postalCode: string;
  address: string;
  tel: string;
}

// 📜 操作履歴（誤操作の確認用に、チェック・チェック解除・削除・追加などを記録する）
interface ActionLogEntry {
  id: string;
  timestamp: string;
  room: string;
  patientName: string;
  action: string;   // 例：チェック / チェック解除 / 削除 / 手動追加 / 退去
  detail: string;   // 対象となった指示内容の文言など
  user: string;      // 実施者（ログイン中のユーザーID）
}

interface EmergencySummary {
  nameKana: string;              // ふりがな
  birthDate: string;             // 生年月日（yyyy-mm-dd。これを元に年齢を自動計算する。未入力なら年齢欄は表示しない）
  keyPersons: KeyPerson[];       // キーパーソン①②…
  mainDiseasesText: string;      // 主な疾患名
  medications: MedicationDetail[]; // 内服薬
  medicationNotebookLocation: string; // お薬手帳の保管場所
  allergyText: string;           // アレルギー内容
  contraindicatedMedications: ContraindicatedMedication[]; // 禁忌薬（絶対に避ける薬剤）
  infectionStatusItems: InfectionStatusItem[]; // 感染症有無
  lastTestDate: string;          // 最終検査日
  primaryDoctorClinic: string;   // かかりつけ医院名
  primaryDoctorName: string;     // 担当医
  primaryDoctorPostalCode: string; // かかりつけ医郵便番号（数字7桁。入力完了すると住所欄に都道府県～市区町村を自動入力する）
  primaryDoctorAddress: string;  // かかりつけ医住所
  primaryDoctorTel: string;      // かかりつけ医TEL
  emergencyHospitalName: string;    // 救急搬送希望先
  emergencyHospitalPostalCode: string; // 救急搬送希望先郵便番号（数字7桁。入力完了すると住所欄に都道府県～市区町村を自動入力する）
  emergencyHospitalAddress: string; // 救急搬送希望先住所
  emergencyHospitalTel: string;     // 救急搬送希望先TEL
  lastUpdated: string;           // 最終更新日
  updatedBy: string;             // 最終更新者（ログイン中のユーザーIDを保存時に自動記録）
}

// 👤 スタッフ管理：ログインできる氏名・ID・パスワードの1件分
interface StaffAccount {
  name: string;
  id: string;
  password: string;
}

// 📋 2週間ごとの定期往診サイクルを開始する際、リセット前の内容をそのまま保存しておく記録（履歴として蓄積）
interface VisitRecord {
  id: string;
  date: string; // 記録した日付（例：2026年8月28日）
  timestamp: number; // 並び替え用（新しい順に並べるため）
  kt: string;
  bp: string;
  spo2: string;
  p: string;
  reportToDoctor: string;
  doctorMemo: string;
  doctorOrder: string;
  orderStatus: { [lineIndex: number]: { checked: boolean; Sign?: string } };
  orderCreatedBy: { [lineIndex: number]: string };
  orderPeriods: { [lineIndex: number]: { startDate: string; durationDays: number | null; endDate?: string; manualText?: string } };
  prnMedications: { [itemId: string]: { checked: boolean; checkedBy?: string; checkedAt?: string } };
  observationList: string;
  observationStatus: { [lineIndex: number]: { checked: boolean; checkedBy?: string; checkedAt?: string } };
  lastEditedBy: string;
  lastEditedAt: string;
  suppliesUsedSnapshot: { name: string; used: number }[];
  // 📜 時系列（既往歴）用のAI要約。看護師が手直しして保存できる
  timelineSummary?: string;
  timelineSummaryEditedBy?: string;
  timelineSummaryEditedAt?: string;
  // ✏️ VS・医師連携の「履歴▼」で追加修正した記録：表には出さず、✏️編集ボタンにカーソルを合わせた時だけ
  // 一覧で表示する。上書きせず追記していくため、複数回編集した場合は全ての回がここに残る
  archiveEditHistory?: { editedBy: string; editedAt: string }[];
}

interface Patient {
  id: string;
  name: string;
  room: string;
  gender: 'male' | 'female';
  age: number | null; // 生年月日から自動計算される満年齢。生年月日未入力ならnull
  kt: string;
  bp: string;
  spo2: string;
  p: string;
  reportToDoctor: string;
  // 📅 次回往診サイクル開始時、①報告内容欄に薄く表示する「2週間前の医師指示メモ」のヒント文言
  prevDoctorMemoHint: string;
  // 📎 部屋図でスキャン・添付した書類（ダブルクリックで閲覧できる）。dataUrlに画像本体を持つため、
  // 大きな画像を何枚も添付するとlocalStorageの容量を圧迫する点に留意（クライアントのみで完結するアプリのため）
  attachedFiles: { id: string; name: string; type: 'image' | 'video' | 'file'; dataUrl: string }[];
  doctorMemo: string;
  doctorOrder: string;
  // チェック情報に「誰がいつ実行したか」のテキストを持たせる
  orderStatus: { [lineIndex: number]: { checked: boolean; Sign?: string } };
  // ✏️ ③指示内容の各行を「誰が記載したか」を記録する（保存＝記載した時点でログイン中のユーザー名を残す）
  orderCreatedBy: { [lineIndex: number]: string };
  // 🗓️ ③指示内容の各行に紐づく期間（開始日＋日数）。例：開始日8/24、7日間 → 8/24～8/30
  orderPeriods: { [lineIndex: number]: { startDate: string; durationDays: number | null; endDate?: string; manualText?: string } };
  // 🩺 医師指示メモから自動で候補提示された指示のうち、看護師が「不要」として消去したものを記録（再提示を防ぐ）
  dismissedSuggestions: string[];
  isChangedInstruction: boolean;
  // 💊 頓用薬：定型項目ごとの選択状態＋チェックした人・日時（部屋図と同様に管理者パスワードで確認する）
  prnMedications: { [itemId: string]: { checked: boolean; checkedBy?: string; checkedAt?: string } };
  // 💊 頓用薬の文言を患者ごとにダブルクリックで編集した場合の上書きテキスト（未設定なら定型文言を使用）
  prnMedicationTextOverrides: { [itemId: string]: string };
  // ✏️ 頓用薬の文言を最後に編集した人・日時（カーソルを合わせると表示）
  prnMedicationTextMeta: { [itemId: string]: { editedBy: string; editedAt: string } };
  // ✍️ 頓用薬：定型項目にない内容を手動で自由記載したもの（カテゴリ名・実施者・日時つき）
  prnManualEntries: { id: string; group: string; text: string; addedBy: string; addedAt: string }[];
  // 🔀 頓用薬：選択済み項目の表示順（ドラッグで並べ替えた結果を保存。定型項目のid or 手動記載のidの並び）
  prnSelectedOrder: string[];
  // 👁️ 観察要点：②医師指示管理・③指示内容の記載内容から自動で候補が挙がる観察項目チェックリスト
  observationList: string;
  observationStatus: { [lineIndex: number]: { checked: boolean; checkedBy?: string; checkedAt?: string } };
  dismissedObservations: string[];
  // 🕒 この患者のデータをどこかの画面で最後に更新した人・日時（各画面でカーソルを合わせると見える）
  lastEditedBy: string;
  lastEditedAt: string;
  extractedDiseases: string[];
  currentMedications: string[];
  medicationHistory: string[];
  hasBalloon: boolean;
  lastExchangeDate: string;
  nextExchangeDate: string;
  isExchangeChecked: boolean;
  // 📦 物品管理の一覧には、この配列に「物品名が入力された項目」を1つでも持つ人だけが表示される
  // （部屋図から選んで最初の物品名を入力すると一覧に現れる。物品名の入っていない項目だけの人は表示されない）
  supplies: SupplyItem[];
  dnr: boolean;
  gtube: boolean;
  cvport: boolean;
  facilityEndofLife: boolean;
  cpr: boolean;
  respirator: boolean;
  emergencyTransport: boolean;
  oxygen: boolean;
  ivDrip: boolean;
  emergencySummary: EmergencySummary;
  // 📋 過去の往診記録（次回往診サイクル開始時にリセット前の内容を保存。新しいものが先頭）
  visitHistory: VisitRecord[];
}

// 🌐 複数端末で共有するデータ（入居者データ・業務連絡シート・往診日）を、サーバー（/api/state）と
// やり取りする際のまとまり。localStorageのキーと1対1で対応する（詳細は /api/state のコメントを参照）
interface SharedAppState {
  patients: Patient[];
  nextVisitDate: string;
  handoverNote: string;
  savedHandoverNote: string;
  handoverNoteSavedBy: string;
  handoverNoteSavedAt: string;
  savedHandoverNoteDate: string;
  handoverNoteConfirmed: boolean;
  handoverNoteArchive: Record<string, { text: string; savedAt: string; savedBy: string }>;
}

// 🔒 部屋図に表示される「意思決定・緊急時対応」レ点の項目一覧。1件ずつ個別にパスワードを聞くと手間なので、
// どれか1つをクリックしたら現在部屋図に表示されている全入居者分をまとめて編集できる画面を開き、
// パスワード確認は保存時に1回だけ行う（一括編集モーダルと各部屋カードの両方でこの一覧を共通利用する）
type MapCheckboxFieldKey = 'dnr' | 'gtube' | 'oxygen' | 'facilityEndofLife' | 'cvport' | 'ivDrip' | 'cpr' | 'respirator' | 'emergencyTransport';
const MAP_CHECKBOX_FIELDS: { key: MapCheckboxFieldKey; label: string }[] = [
  { key: 'dnr', label: '蘇生拒否' },
  { key: 'gtube', label: '胃ろう' },
  { key: 'oxygen', label: '酸素' },
  { key: 'facilityEndofLife', label: '施設内看取り' },
  { key: 'cvport', label: 'CVポート' },
  { key: 'ivDrip', label: '点滴' },
  { key: 'cpr', label: '心マ' },
  { key: 'respirator', label: '呼吸器' },
  { key: 'emergencyTransport', label: '救急搬送' },
];

// 🚨 緊急時対応サマリーシートの空データを生成するヘルパー
// 🩺 医師指示メモのキーワードから③指示内容の候補を自動抽出するルール
// （キーワードのいずれかが医師指示メモの文中に含まれていれば、対応する指示を候補として提示する）
const INSTRUCTION_SUGGESTION_RULES: { keywords: string[]; suggestion: string }[] = [
  { keywords: ['呼吸苦', '息切れ', '喘鳴', 'SpO2低下', '呼吸困難', '陥没呼吸'], suggestion: '酸素療法' },
  { keywords: ['呼吸苦', '浮腫', '食事量低下', 'ふらつき', '倦怠感', '脱水'], suggestion: '採血' },
  { keywords: ['浮腫', '食事量低下', '脱水', '経口摂取低下', '尿量低下'], suggestion: '点滴' },
  { keywords: ['発熱', '呼吸苦', '排膿', '発赤', '咳嗽', '喀痰', '褥瘡'], suggestion: '抗生剤' },
];

// 候補として画面に並べる際の優先順（重複を除いてこの順序で表示する）
const INSTRUCTION_SUGGESTION_ORDER = ['採血', '酸素療法', '点滴', '抗生剤'];

// 医師指示メモの文章から候補となる指示の一覧を返す
const getSuggestedInstructions = (memoText: string): string[] => {
  if (!memoText || !memoText.trim()) return [];
  const matched = new Set<string>();
  INSTRUCTION_SUGGESTION_RULES.forEach(rule => {
    if (rule.keywords.some(kw => memoText.includes(kw))) {
      matched.add(rule.suggestion);
    }
  });
  return INSTRUCTION_SUGGESTION_ORDER.filter(s => matched.has(s));
};

// 👁️ ②VS・状態報告・医師指示／③指示内容の記載内容から、観察要点の候補を自動抽出するルール
// ※項目は今後どんどん追加していく想定。配列に { keywords, item } を足すだけで拡張できます。
const OBSERVATION_SUGGESTION_RULES: { keywords: string[]; item: string }[] = [
  { keywords: ['血圧', 'BP', '降圧', '昇圧'], item: '血圧値' },
  { keywords: ['呼吸苦', '息切れ', '呼吸困難', '陥没呼吸', '酸素療法'], item: '呼吸苦' },
  { keywords: ['浮腫', '点滴', '脱水', '尿量低下', '経口摂取低下'], item: '尿量/尿回数' },
  { keywords: ['喘鳴', '呼吸苦', '酸素療法'], item: '喘鳴' },
  { keywords: ['発熱', '抗生剤', '感染'], item: '体温' },
  { keywords: ['褥瘡', '皮膚', '発赤'], item: '皮膚状態' },
  { keywords: ['食事量低下', '経口摂取低下'], item: '食事摂取量' },
];

// 候補として画面に並べる際の優先順（重複を除いてこの順序で表示する）
const OBSERVATION_SUGGESTION_ORDER = ['血圧値', '呼吸苦', '尿量/尿回数', '喘鳴', '体温', '皮膚状態', '食事摂取量'];

// 💊 頓用薬の定型項目（クリックで選択できる固定リスト）
const PRN_MEDICATION_OPTIONS: { id: string; group: string; text: string }[] = [
  { id: 'fever_1', group: '発熱時（38.0以上）', text: 'カロナール（200）２T　３回/日まで' },
  { id: 'fever_2', group: '発熱時（38.0以上）', text: '内服困難でBP100以上ある時：ボルタレンSP（25）１個挿肛門　3個/日まで' },
  { id: 'fever_3', group: '発熱時（38.0以上）', text: 'アセリオ静注液1000　15分かけて静脈注射　※解熱しない時は6時間開けてカロナール（200）２T' },
  { id: 'nausea_1', group: '嘔気時', text: 'ナウゼリン座薬　１個挿肛門　※3個/日まで' },
  { id: 'stomach_1', group: '胃部不快・胃痛', text: 'ファモチジン　３回/日まで' },
  { id: 'constipation_1', group: '便秘時', text: 'ピコスルファートNa液10滴夕食後' },
  { id: 'lowintake_1', group: '食事量低下（昨夕から翌日昼までいつもの半分以下）', text: 'エンシュアHi1缶/日' },
  { id: 'hypertension_1', group: '血圧180/以上', text: 'アムロジピン（25）１T　1時間後改善なければDrコール' },
  { id: 'toothache_1', group: '歯痛', text: 'ロキソニン１T＋レバミピド１T　３回/日まで' },
];

// 💊 患者の頓用薬が1つでも選択されているか判定する
const hasAnyPrnSelected = (p: Patient): boolean => PRN_MEDICATION_OPTIONS.some(opt => p.prnMedications[opt.id]?.checked) || (p.prnManualEntries?.length ?? 0) > 0;

// 📦 物品管理：物品名は自由入力ではなく、この定型カタログ（物品タイトル→物品名）から選ぶ方式にする
// （スタッフごとの表記ゆれを防ぐため）。物品名欄をクリックするとまず物品タイトルの一覧が表示され、
// タイトルを選ぶとその中の物品名一覧に切り替わり、選ぶと物品名欄に入る
const SUPPLY_CATALOG: { title: string; items: string[] }[] = [
  { title: '採血', items: [
    'ニプロPSVセット22G(翼状針)', 'ニプロPSVセット23G(翼状針)', '採血ホルダー付きルアー',
    'JMSシリンジ10ml', 'JMSシリンジ20ml', 'スピッツ(A・B・F)３本セット', 'スピッツ(C) 凝固',
    'サニコットデズイン60包(個包装)', 'ブラッドバン(100回分入り)',
    '感染用　医療廃棄物BOX（大）', '感染用　医療廃棄物BOX（小）', '抜糸セット',
  ] },
  { title: '注射', items: [
    'スーパーキャス22G(留置針)', 'スーパーキャス24G(留置針)',
    'テルフュージョン輸液セット(20滴)', 'テルフュージョン輸液セット(60滴)',
    'サフィード延長チューブ', 'テルフュージョン延長チューブ付三方活栓', 'テルフュージョン三方活栓',
    '三方活栓用キャップ', 'シュアプラグ', 'テガダームフィルムロール(10cm×10cm)',
    'アルコール綿　サニコットデズイン(個包装)', 'ワンショットプラス(ヘキシジン)(個包装)',
    'サージカルテープ(1.25cm×9.1m)', 'サージカルテープ(2.5cm×9.1m)',
  ] },
  { title: '経管栄養', items: [
    '加圧バック', 'カテーテルチップシリンジ50ml', 'ジェイフィード栄養セット(栄養チューブ)',
    'ジェイフィード栄養ボトル', 'ラコールNFアダプタ', '変換コネクタ(PEG・経鼻コネクタ新規格の接続用)',
  ] },
  { title: '気切', items: [
    'ネックテープ', 'サーモベント人口鼻　T2（25個入り）',
    'ソフィットベント人口鼻　SV-L（30個入り）', 'ソフィットベント人口鼻　SV-LO2（30個入り）',
  ] },
  { title: '保護フィルム', items: ['テガダーム　10cm×10m'] },
  { title: '包帯', items: ['伸縮包帯', '弾性包帯4号'] },
  { title: 'テープ', items: ['シルキーポアホワイト　5号', 'カブレステープ　No19'] },
  { title: '膀胱留置カテーテル', items: [
    'シリコーンBaカテーテルセット＋シリンジ10ml',
    'オールシリコーンフォーリートレイキット(14Fr)', 'オールシリコーンフォーリートレイキット(16Fr)',
    'オールシリコーンフォーリートレイキット(18Fr)', 'Ba固定用テープ(シルキーポア)',
  ] },
  { title: '血糖測定', items: [
    'メディセーフ針(30本入り)', 'メディセーフフィットチップ(30個入り)', 'ジェントレット針(30本入り)',
    'グルテストNEOセンサー(30枚入り)', 'フリースタイルリブレセンサー',
    'サニコットデズイン60包(個包装)', 'サニコットデズインCap(104枚入り)',
  ] },
  { title: '導尿セット', items: ['ネラトンカテーテル12Fr', 'ぬるゼリー'] },
  { title: '吸引カテーテル', items: ['吸引カテーテル10Fr', '吸引カテーテル14Fr'] },
  { title: 'ガーゼ', items: ['滅菌Yカットガーゼ', '尺角ガーゼ300枚入'] },
  { title: '消毒綿棒', items: ['プッシュ綿棒(イソジン綿棒)', 'テガダーム　10cm×10m'] },
];

// 🕒 日時のフォーマット（例：08/28 14:05）
const formatNowTimestamp = (): string => {
  const now = new Date();
  return `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
};

// ②医師指示管理＋③指示内容の合算テキストから、観察要点の候補一覧を返す
const getSuggestedObservations = (combinedText: string): string[] => {
  if (!combinedText || !combinedText.trim()) return [];
  const matched = new Set<string>();
  OBSERVATION_SUGGESTION_RULES.forEach(rule => {
    if (rule.keywords.some(kw => combinedText.includes(kw))) {
      matched.add(rule.item);
    }
  });
  return OBSERVATION_SUGGESTION_ORDER.filter(s => matched.has(s));
};

// 👁️ ②③の内容が変わるたびに呼び出し、観察要点の候補を最新化する（未追加の候補だけ追記する）
const syncObservationSuggestions = (p: Patient): Patient => {
  const combinedText = `${p.doctorMemo}\n${p.doctorOrder}`;
  const suggestions = getSuggestedObservations(combinedText);
  const existingLines = p.observationList.split('\n').map(l => l.trim()).filter(l => l !== '');
  const linesToAdd = suggestions.filter(s => !existingLines.includes(s) && !p.dismissedObservations.includes(s));
  if (linesToAdd.length === 0) return p;
  const currentList = p.observationList.trim();
  const nextList = currentList ? `${currentList}\n${linesToAdd.join('\n')}` : linesToAdd.join('\n');
  return { ...p, observationList: nextList };
};

// 🗓️ 日付(YYYY-MM-DD)を "M/D" 表記に変換
const formatDateShort = (isoDate: string): string => {
  if (!isoDate) return '';
  const d = new Date(isoDate + 'T00:00:00');
  if (isNaN(d.getTime())) return isoDate;
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

// 🗓️ 今日の日付をYYYY-MM-DD形式で返す
const getTodayISO = (): string => {
  const today = new Date();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  return `${today.getFullYear()}-${mm}-${dd}`;
};

// 🗓️ 画面右上に常時表示する暦（日本時間の0時をまたぐたびに切り替わる）。
// 端末側のタイムゾーン設定に関わらず必ず日本時間で判定するため、現在時刻(UTC)に+9時間した上でUTC系のgetterで
// 読み取る（このズラした値をUTCとして読むと、日本時間の年月日・曜日がそのまま取れる）
const JST_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const formatJstTodayLabel = (): string => {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日(${JST_WEEKDAYS[jst.getUTCDay()]})`;
};

// 📦 物品の使用予定日カレンダー：「月」「火」…などの曜日＋「2週間おき」「30日おき」から、
// 表示中の月の中でその条件に当てはまる日にちをまとめて求める。
// 例：月曜・2週間おきを9月で選ぶと、9月のうち最初の月曜を基準に2週間（14日）おきの月曜だけを返す
// （30日おきは曜日が7の倍数でないためズレていくが、同じ考え方で「最初の該当曜日」を基準日数として使う）
const generateRecurringWeekdayDates = (yyyymm: string, weekday: number, intervalDays: number): string[] => {
  const [y, m] = yyyymm.split('-').map(Number);
  if (!y || !m) return [];
  const daysInMonth = new Date(y, m, 0).getDate();
  const matchingDates: string[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(y, m - 1, d).getDay() === weekday) {
      matchingDates.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }
  if (matchingDates.length === 0) return [];
  const anchor = new Date(matchingDates[0] + 'T00:00:00');
  return matchingDates.filter(iso => {
    const diffDays = Math.round((new Date(iso + 'T00:00:00').getTime() - anchor.getTime()) / 86400000);
    return diffDays % intervalDays === 0;
  });
};

// 📦 物品管理の請求月（YYYY-MM）を「2026年9月分」のような表示用テキストに変換する
const formatBillingMonthLabel = (yyyymm: string): string => {
  if (!yyyymm) return '未設定';
  const [y, m] = yyyymm.split('-');
  return `${y}年${parseInt(m, 10)}月分`;
};

// 📦 物品の「作成日」（YYYY-MM-DD）を、定期作成の時だけ月のみの表示用テキスト（「2026年9月」）に変換する
const formatSupplyItemCreationMonthLabel = (isoDate: string): string => {
  if (!isoDate) return '未設定';
  const [y, m] = isoDate.slice(0, 7).split('-');
  return `${y}年${parseInt(m, 10)}月`;
};

// 📦 請求月（YYYY-MM）をdeltaヶ月分前後にずらす
const shiftMonthISO = (yyyymm: string, delta: number): string => {
  const [y, m] = yyyymm.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// 🗓️ 開始日＋日数から「8/24～8/30」のような期間表示テキストを作る
const formatOrderPeriod = (entry?: { startDate: string; durationDays: number | null; endDate?: string; manualText?: string }): string => {
  if (!entry) return '未設定';
  if (entry.manualText) return entry.manualText;
  if (!entry.startDate) return '未設定';

  // ★ 保存時に確定した終了日がある場合は、それを最優先で表示する。
  // これにより「期間の設定」画面と④日/期間が必ず同じ日付になる。
  if (entry.endDate) {
    if (entry.endDate === entry.startDate) return formatDateShort(entry.startDate);
    return `${formatDateShort(entry.startDate)}～${formatDateShort(entry.endDate)}`;
  }

  if (!entry.durationDays) return `${formatDateShort(entry.startDate)}～`;
  if (entry.durationDays === 1) return formatDateShort(entry.startDate);

  const endIso = getOrderEndDateISO(entry.startDate, entry.durationDays);
  return `${formatDateShort(entry.startDate)}～${formatDateShort(endIso)}`;
};

// 🗓️ 開始日＋日数から終了日(YYYY-MM-DD)を返す
// 例：開始日8/24・7日間 → 終了日8/30
const getOrderEndDateISO = (startDate: string, durationDays: number | null): string => {
  if (!startDate || !durationDays || durationDays < 1) return '';
  const start = new Date(startDate + 'T00:00:00');
  if (isNaN(start.getTime())) return '';
  const end = new Date(start);
  end.setDate(start.getDate() + (durationDays - 1));
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
};

// 🚨 ③指示内容の行を、④日/期間の開始日が近づいている・過ぎているのに未実施（レ点なし）の場合に
// ピカピカ点滅させて知らせるための判定。開始日の前日は黄色、開始日当日およびそれ以降は赤で知らせる
// （手動で自由記述した期間や、実施済み（レ点あり）の行は対象外）
const getOrderLineAlertLevel = (
  periodEntry: { startDate: string; durationDays: number | null; endDate?: string; manualText?: string } | undefined,
  isChecked: boolean
): 'none' | 'yellow' | 'red' => {
  if (isChecked || !periodEntry || periodEntry.manualText || !periodEntry.startDate) return 'none';
  const startDate = new Date(periodEntry.startDate + 'T00:00:00');
  if (isNaN(startDate.getTime())) return 'none';
  const today = new Date(getTodayISO() + 'T00:00:00');
  const diffDays = Math.round((startDate.getTime() - today.getTime()) / 86400000);
  if (diffDays <= 0) return 'red';
  if (diffDays === 1) return 'yellow';
  return 'none';
};

// 🚨 ある入居者の③指示内容に、指定した点滅アラート（黄または赤）の行が1つでもあるか判定する
// （ログイン画面で「医師指示アラームあり」を黄・赤それぞれ別の段で表示するために使う）
const patientHasOrderAlertLevel = (p: Patient, level: 'yellow' | 'red'): boolean => {
  return p.doctorOrder.split('\n').some((line, idx) => {
    if (line.trim() === '') return false;
    const status = p.orderStatus[idx] || { checked: false };
    return getOrderLineAlertLevel(p.orderPeriods[idx], status.checked) === level;
  });
};

// 🗓️ 期間の開始日が、往診日より前になっていないか判定する（誤入力の確認用）
const isPeriodStartBeforeVisitDate = (entry: { startDate: string } | undefined, nextVisitDateJp: string): boolean => {
  if (!entry || !entry.startDate || !nextVisitDateJp) return false;
  const visitIso = parseJapaneseDateToISO(nextVisitDateJp);
  if (!visitIso) return false;
  return entry.startDate < visitIso;
};

// 🗓️ 往診日（和暦表記）とYYYY-MM-DD形式を相互変換するヘルパー
const parseJapaneseDateToISO = (jpDate: string): string => {
  const m = jpDate.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return '';
  const [, y, mo, d] = m;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};
const formatISOToJapaneseDate = (iso: string): string => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};
// 🎂 生年月日（yyyy-mm-dd）と本日の日付から満年齢を計算する。生年月日が未入力・不正な場合は null（＝年齢欄なし）
const calculateAge = (birthDateISO: string): number | null => {
  if (!birthDateISO) return null;
  const birth = new Date(birthDateISO + 'T00:00:00');
  if (isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const hasHadBirthdayThisYear =
    today.getMonth() > birth.getMonth() ||
    (today.getMonth() === birth.getMonth() && today.getDate() >= birth.getDate());
  if (!hasHadBirthdayThisYear) age -= 1;
  return age;
};
// 📚 内服薬・禁忌薬・感染症有無の入力履歴一覧を、あいうえお順（日本語の並び順）で表示するための並べ替え
const sortJaAsc = <T,>(list: T[], toText: (item: T) => string): T[] =>
  [...list].sort((a, b) => toText(a).localeCompare(toText(b), 'ja'));
// 📦 物品管理：以前の保存データ（使用数=used、使用予定日=単一のscheduledUseDate）を、
// 新しい形（在庫=stock、使用予定日=複数のscheduledUseDates配列）へ変換する。すでに新しい形なら何もしない
const migrateSupplyItem = (raw: unknown): SupplyItem => {
  const r = raw as Partial<SupplyItem> & { used?: number; scheduledUseDate?: string };
  const stock = typeof r.stock === 'number' ? r.stock : Math.max(0, (r.allocated ?? 0) - (r.used ?? 0));
  const scheduledUseDates: SupplyScheduledUseEntry[] = Array.isArray(r.scheduledUseDates)
    ? r.scheduledUseDates
    : (r.scheduledUseDate ? [{ date: r.scheduledUseDate, applied: false }] : []);
  return {
    id: r.id ?? `s_${Date.now()}`,
    name: r.name ?? '',
    allocated: r.allocated ?? 0,
    baseAllocated: r.baseAllocated ?? r.allocated ?? 0,
    // ⚠️ 新規に導入した項目なので、既存データでは「今月すでにリセット済み」扱いにしておき、
    // 読み込んだ直後にいきなり定数がリセットされてしまわないようにする
    lastResetMonth: r.lastResetMonth ?? getTodayISO().slice(0, 7),
    stock,
    unit: r.unit ?? '個',
    kind: r.kind ?? '定数',
    memo: r.memo ?? '',
    scheduledUseDates,
  };
};
// 🗓️ 生年月日入力で選べる暦。「西暦」以外は元号（和暦）
type BirthDateEraMode = '西暦' | '明治' | '大正' | '昭和' | '平成' | '令和';
const BIRTH_DATE_ERA_MODES: BirthDateEraMode[] = ['西暦', '明治', '大正', '昭和', '平成', '令和'];
// 元号ごとの開始日（この日以降がその元号）。新しい元号から順に判定する
const JAPANESE_ERAS: { name: Exclude<BirthDateEraMode, '西暦'>; start: string }[] = [
  { name: '令和', start: '2019-05-01' },
  { name: '平成', start: '1989-01-08' },
  { name: '昭和', start: '1926-12-25' },
  { name: '大正', start: '1912-07-30' },
  { name: '明治', start: '1868-01-25' },
];
// ⌨️ 生年月日の数字だけ入力を、選択中の暦に応じて表示用にスラッシュ区切りへ整形する（西暦：yyyy/mm/dd、和暦：ee/mm/dd）
const formatBirthDateDigitsForInput = (digits: string, mode: BirthDateEraMode): string => {
  const headLen = mode === '西暦' ? 4 : 2;
  const head = digits.slice(0, headLen);
  const m = digits.slice(headLen, headLen + 2);
  const d = digits.slice(headLen + 2, headLen + 4);
  let out = head;
  if (m) out += '/' + m;
  if (d) out += '/' + d;
  return out;
};
// ⌨️ 選択中の暦での数字入力（西暦なら8桁yyyymmdd、和暦なら6桁eemmdd）を生年月日のyyyy-mm-dd形式に変換する。
//    桁が揃っていない・実在しない日付・元号の範囲外なら空文字を返す
const digitsToISOBirthDate = (digits: string, mode: BirthDateEraMode): string => {
  if (mode === '西暦') {
    if (digits.length !== 8) return '';
    const y = Number(digits.slice(0, 4));
    const m = Number(digits.slice(4, 6));
    const d = Number(digits.slice(6, 8));
    return buildValidISODate(y, m, d);
  }
  if (digits.length !== 6) return '';
  const era = JAPANESE_ERAS.find(e => e.name === mode);
  if (!era) return '';
  const eraYear = Number(digits.slice(0, 2));
  const m = Number(digits.slice(2, 4));
  const d = Number(digits.slice(4, 6));
  const eraStartYear = new Date(era.start + 'T00:00:00').getFullYear();
  const y = eraStartYear + eraYear - 1;
  const iso = buildValidISODate(y, m, d);
  // 変換した西暦日が実際にその元号の期間内かどうかも確認する（例：昭和65年のような存在しない組み合わせを弾く）
  if (!iso) return '';
  return detectEraModeForISO(iso) === mode ? iso : '';
};
// 📅 年月日（数値）が実在する日付かどうか確認し、実在すればyyyy-mm-dd形式で返す。存在しなければ空文字
const buildValidISODate = (y: number, m: number, d: number): string => {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  const iso = `${y}-${mm}-${dd}`;
  const test = new Date(iso + 'T00:00:00');
  const isRealDate = !isNaN(test.getTime()) && test.getFullYear() === y && test.getMonth() + 1 === m && test.getDate() === d;
  return isRealDate ? iso : '';
};
// 🗓️ 生年月日（yyyy-mm-dd）が属する元号を判定する。1868年（明治元年）より前など、どの元号にも属さない場合は西暦のまま扱う
const detectEraModeForISO = (iso: string): BirthDateEraMode => {
  if (!iso) return '西暦';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '西暦';
  for (const era of JAPANESE_ERAS) {
    if (d.getTime() >= new Date(era.start + 'T00:00:00').getTime()) return era.name;
  }
  return '西暦';
};
// 🗓️ 生年月日（yyyy-mm-dd）を元号表記（例：昭和16年4月15日）に変換する。元号の対象外なら西暦表記のまま返す
const formatISOToEraDate = (iso: string): string => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  const mode = detectEraModeForISO(iso);
  if (mode === '西暦') return formatISOToJapaneseDate(iso);
  const era = JAPANESE_ERAS.find(e => e.name === mode)!;
  const eraYear = d.getFullYear() - new Date(era.start + 'T00:00:00').getFullYear() + 1;
  const eraYearLabel = eraYear === 1 ? '元' : String(eraYear);
  return `${era.name}${eraYearLabel}年${d.getMonth() + 1}月${d.getDate()}日`;
};
// ⌨️ 生年月日（yyyy-mm-dd）を、指定した暦での数字入力欄の中身（西暦8桁 or 和暦6桁）に復元する
const isoToBirthDateDigits = (iso: string, mode: BirthDateEraMode): string => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  if (mode === '西暦') return `${d.getFullYear()}${mm}${dd}`;
  const era = JAPANESE_ERAS.find(e => e.name === mode);
  if (!era) return '';
  const eraYear = d.getFullYear() - new Date(era.start + 'T00:00:00').getFullYear() + 1;
  if (eraYear < 1) return '';
  return `${String(eraYear).padStart(2, '0')}${mm}${dd}`;
};
// ⌨️ 郵便番号の数字だけ入力を、表示用に「123-4567」の形へ整形する
const formatPostalCodeForInput = (digits: string): string => {
  // ⚠️ postalCodeフィールド追加より前に保存されたlocalStorageのデータにはこの項目がなく、
  //    実行時にundefinedのまま渡ってくることがあるため、空文字として扱う
  const safeDigits = digits || '';
  const head = safeDigits.slice(0, 3);
  const tail = safeDigits.slice(3, 7);
  return tail ? `${head}-${tail}` : head;
};
// 🏠 郵便番号（数字7桁）から住所（都道府県～町域）を検索する。zipcloud（無料・APIキー不要の郵便番号検索API）を利用する。
// 見つからない・通信に失敗した場合はnullを返す（住所欄は自由入力のまま使えるので、失敗しても致命的にはならない）
const lookupAddressByPostalCode = async (digits: string): Promise<string | null> => {
  try {
    const res = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${digits}`);
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.results?.[0];
    if (!result) return null;
    return `${result.address1 ?? ''}${result.address2 ?? ''}${result.address3 ?? ''}`;
  } catch {
    return null;
  }
};

const createEmptyEmergencySummary = (): EmergencySummary => ({
  nameKana: '',
  birthDate: '',
  keyPersons: [
    { id: `kp_${Date.now()}_1`, name: '', relation: '', tel1: '', tel2: '', postalCode: '', address: '' },
    { id: `kp_${Date.now()}_2`, name: '', relation: '', tel1: '', tel2: '', postalCode: '', address: '' },
  ],
  mainDiseasesText: '',
  medications: [
    { id: `m_${Date.now()}_1`, name: '', dosageTiming: '' },
  ],
  medicationNotebookLocation: '',
  allergyText: '',
  contraindicatedMedications: [
    { id: `cm_${Date.now()}_1`, name: '' },
  ],
  infectionStatusItems: [
    { id: `is_${Date.now()}_1`, text: '' },
  ],
  lastTestDate: '',
  primaryDoctorClinic: '',
  primaryDoctorName: '',
  primaryDoctorPostalCode: '',
  primaryDoctorAddress: '',
  primaryDoctorTel: '',
  emergencyHospitalName: '',
  emergencyHospitalPostalCode: '',
  emergencyHospitalAddress: '',
  emergencyHospitalTel: '',
  lastUpdated: '',
  updatedBy: '',
});

// ==========================================
// 2. 初期データ（バイタル初期値は「記入なし」の空文字に統一）
// ==========================================
const initialPatients: Patient[] = [
  {
    id: '1', name: '山田 太郎 様', room: '101', gender: 'male', age: 84, 
    kt: '36.0', bp: '107/60', spo2: '', p: '', 
    reportToDoctor: '夕方から呼吸苦の訴えあり。吸気時に軽度の陥没呼吸がみられます。',
    prevDoctorMemoHint: '',
    attachedFiles: [], doctorMemo: '呼吸苦に対する指示明確化。',
    doctorOrder: "次週木曜日に緊急採血実施\n家族へ病状説明（IC）アポ取り",
    orderStatus: { 0: { checked: false }, 1: { checked: false } },
    orderCreatedBy: { 0: 'jam', 1: 'jam' },
    orderPeriods: { 0: { startDate: '2026-08-24', durationDays: 7 }, 1: { startDate: '2026-08-24', durationDays: 14 } },
    dismissedSuggestions: [],
    isChangedInstruction: true,
    prnMedications: { fever_1: { checked: true, checkedBy: 'jam', checkedAt: '08/24 10:00' } },
    prnMedicationTextOverrides: {},
    prnMedicationTextMeta: {},
    prnManualEntries: [],
    prnSelectedOrder: [],
    observationList: '呼吸苦\n血圧値',
    observationStatus: {},
    dismissedObservations: [],
    lastEditedBy: 'jam',
    lastEditedAt: '08/24 10:00',
    extractedDiseases: ['慢性心不全'], currentMedications: ['メインテート'], medicationHistory: [],
    hasBalloon: true, lastExchangeDate: '2026-05-15', nextExchangeDate: '2026-05-29', isExchangeChecked: false,
    supplies: [{ id: 's1', name: 'バルンキット 14Fr', allocated: 2, baseAllocated: 2, lastResetMonth: getTodayISO().slice(0, 7), stock: 1, unit: '個', kind: '定数', memo: '', scheduledUseDates: [] }],
    dnr: true, gtube: false, cvport: false, facilityEndofLife: true, cpr: false, respirator: false, emergencyTransport: false,
    oxygen: false, ivDrip: false,
    emergencySummary: {
      nameKana: 'やまだ たろう',
      birthDate: '',
      keyPersons: [
        { id: 'kp_1_1', name: '山田 花子', relation: '長女', tel1: '090-XXXX-XXXX', tel2: '03-XXXX-XXXX', postalCode: '', address: '東京都〇〇区…' },
        { id: 'kp_1_2', name: '鈴木 一郎', relation: '長男', tel1: '080-YYYY-YYYY', tel2: '06-YYYY-YYYY', postalCode: '', address: '大阪府〇〇市…' },
      ],
      mainDiseasesText: '脳梗塞後遺症、高血圧症、慢性心不全',
      medications: [
        { id: 'm_1_1', name: 'アスピリン腸溶錠 100mg', dosageTiming: '朝食後 1錠' },
        { id: 'm_1_2', name: 'アムロジピン錠 5mg', dosageTiming: '朝食後 1錠' },
        { id: 'm_1_3', name: 'ワーファリン錠 1mg', dosageTiming: '夕食後 1錠' },
      ],
      medicationNotebookLocation: '',
      allergyText: '食物：なし',
      contraindicatedMedications: [
        { id: 'cm_1_1', name: '' },
      ],
      infectionStatusItems: [
        { id: 'is_1_1', text: 'なし（B型肝炎・C型肝炎・MRSA陰性）' },
      ],
      lastTestDate: '202X年〇月〇日',
      primaryDoctorClinic: '〇〇クリニック',
      primaryDoctorName: '佐藤 医師',
      primaryDoctorPostalCode: '',
      primaryDoctorAddress: '',
      primaryDoctorTel: '03-XXXX-XXXX',
      emergencyHospitalName: '〇〇総合病院救急外来',
      emergencyHospitalPostalCode: '',
      emergencyHospitalAddress: '〇〇市〇〇町1-2',
      emergencyHospitalTel: '03-YYYY-YYYY',
      lastUpdated: '2026年〇月〇日',
      updatedBy: 'jam',
    },
    visitHistory: []
  },
  {
    id: '2', name: '佐藤 花子 様', room: '102', gender: 'female', age: 78, 
    kt: '', bp: '', spo2: '', p: '', 
    reportToDoctor: '仙骨部の褥瘡滲出液が増加。',
    prevDoctorMemoHint: '',
    attachedFiles: [], doctorMemo: '抗生剤スポット処方。',
    doctorOrder: "抗生剤（クラビット）7日分処方入力",
    orderStatus: { 0: { checked: true, Sign: '06/09 18:20 admin' } },
    orderCreatedBy: { 0: 'jam' },
    orderPeriods: { 0: { startDate: '2026-08-24', durationDays: 7 } },
    dismissedSuggestions: [],
    isChangedInstruction: false,
    prnMedications: {},
    prnMedicationTextOverrides: {},
    prnMedicationTextMeta: {},
    prnManualEntries: [],
    prnSelectedOrder: [],
    observationList: '皮膚状態',
    observationStatus: {},
    dismissedObservations: [],
    lastEditedBy: 'admin',
    lastEditedAt: '06/09 18:20',
    extractedDiseases: ['脳梗塞後遺症'], currentMedications: ['バイアスピリン'], medicationHistory: [],
    hasBalloon: false, lastExchangeDate: '', nextExchangeDate: '', isExchangeChecked: false,
    supplies: [{ id: 's3', name: 'Yカットガーゼ', allocated: 30, baseAllocated: 30, lastResetMonth: getTodayISO().slice(0, 7), stock: 18, unit: '個', kind: '定数', memo: '', scheduledUseDates: [] }],
    dnr: false, gtube: true, cvport: false, facilityEndofLife: false, cpr: true, respirator: true, emergencyTransport: true,
    oxygen: false, ivDrip: false,
    emergencySummary: { ...createEmptyEmergencySummary(), nameKana: 'さとう はなこ' },
    visitHistory: []
  },
];

// 🈂️ 氏名欄をIMEで変換する直前のひらがなを一時的に保持し、フリガナ欄の自動候補に使う（フリガナは常に手動修正可）。
// ⚠️ 変換確定のたびに読みを無条件に積み上げていく方式は、IMEの変換候補巡回や部分的な変換タイミングによって
// 同じ読みを二重にカウントしてしまう不具合が実機で繰り返し見つかったため採用していない。
// 代わりに「このひとまとまりの変換の中で、それまでに見えた一番長い“まだ漢字に変換されていないひらがな”」だけを
// 信頼できる読みとして扱う（数値は増える一方で、後から巻き戻したり積み増したりしない＝二重カウントが原理的に起きない）。
let nameKanaLiveHiragana = '';
// 🈂️ 1回のIME入力の中で「山田」を変換確定してから、そのまま続けて（一度も確定せず）「太郎」を打つように、
// 複数の文節が同じ変換セッション内で順番に変換されるケース対応。ある時点でe.dataに漢字が混ざり始めたら、
// 「それまでに見えていた読み（nameKanaLiveHiragana）」を“直前の文節の確定読み”として一度だけ確定枠へ移し、
// 以降はe.data末尾に残る未変換のひらがな部分だけを新たに追跡し直す。1回の変換につき1度しか確定枠へ移さない
// ため、候補巡回（同じ文節を何度も漢字候補で表示し直す動き）で同じ読みが重複して積み増されることはない
let nameKanaConfirmedReading = '';
let nameKanaHasConfirmedSegment = false;
// 🈂️ 氏名欄にフォーカスした時点（編集を始める前）の氏名を控えておく。カーソル位置や選択範囲だけを見ると、
// 「古い文節を削除してから新しい文節を打ち直す」という一般的な編集操作を正しく検出できないため、
// 編集前後の氏名全体を文字列として比較（diff）して「どの範囲が変わったか」を特定する方式にしている
let nameAtFocusStart = '';
// 🈂️ 今回のIME変換が始まる直前（バックスペース等での削除が済んだ後）の氏名を控えておく。
// 「文節の一部の文字だけ打ち直す」編集（例：「山田」の「田」だけを「内」に打ち直す）では、
// nameAtFocusStart と比べて文節のテキストが変わって見えても、変換で拾える読みは打ち直した分だけ
// （上の例では「うち」のみ）で文節全体の読みではない。これをそのまま文節のふりがな全体に上書きすると
// 既存の読み（「やま」）が消えてしまうため、この値を使って「文節の文字が今回の編集で全て消えたか」を判定し、
// 一部の文字が残っている場合はふりがなの自動更新をスキップする（既存のふりがなを壊さないことを優先する）
let nameBeforeComposition = '';
// 🈂️ 今回の変換が始まる直前の選択範囲（例：単語をダブルクリックで選択してから打ち直す操作）。
// nameBeforeComposition との文字列比較だけでは、「バックスペース等で事前に削除した部分」しか検出できない。
// 単語を選択してそのまま変換で上書きする操作（プレーンな削除を挟まない）では、選択されていた古い文字が
// この時点ではまだnameBeforeComposition中に残ったままなので、選択範囲も別途持っておき、
// 「事前に削除された範囲」と「これから変換で置き換わる選択範囲」の両方を合わせて判定する
let nameCompositionSelStart = 0;
let nameCompositionSelEnd = 0;

// 🈂️ 氏名欄を「姓」「名」の2つの入力ボックスに分けたことに伴い、内部的には従来通り1つのスペース区切り文字列
// （例：「佐藤 紘一」）として保存する。この2つのヘルパーで分割・結合する（3つ目以降の単語は「名」側にまとめて残す）
const splitFullName = (full: string): [string, string] => {
  const idx = full.indexOf(' ');
  return idx === -1 ? [full, ''] : [full.slice(0, idx), full.slice(idx + 1)];
};
// ⚠️ 姓・名のどちらかが空でも必ずスペースを挟んで結合する（空の方を詰めてしまうと、次にsplitFullNameで
// 分割し直した時に「名」の内容が「姓」の位置に来てしまい、姓を消すと名が姓欄へ“移動”したように見える不具合になる）
const joinFullName = (lastPart: string, firstPart: string): string => `${lastPart} ${firstPart}`;
// 🈂️ 敬称「様」は氏名の入力欄には含めず、画面上は「名」欄の右に固定表示だけする。実データ（Patient.name）には
// 従来通り末尾に「様」を含めて保存するため、編集を始める時に取り除き、保存する時に付け直す
const stripHonorificSuffix = (name: string): string => name.replace(/[\s　]*様[\s　]*$/, '');
const appendHonorificSuffix = (name: string): string => name.endsWith('様') ? name : `${name} 様`;

// 🈂️ 氏名の一部だけを書き換えた時（例：「斎藤」の「藤」だけを「内」に打ち直す）、IMEの変換イベントだけでは
// 「変わった部分の読み」までしか分からず、元の読み全体にどう当てはめればいいか判断できない。この場合の
// フォールバックとして、通信も課金も発生しない辞書内蔵の形態素解析ライブラリ（kuromoji）をブラウザ内で
// 使い、氏名欄に今入っている文字列全体を解析して読み（カタカナ）を求める。辞書の読み込みは初回のみで、
// 一度読み込めば以降はブラウザ内で完結する（サーバー通信なし・料金なし）
let kuromojiTokenizerPromise: Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>> | null = null;
const getKuromojiTokenizer = (): Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>> => {
  if (!kuromojiTokenizerPromise) {
    kuromojiTokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: '/dict/' }).build((err, tokenizer) => {
        if (err) reject(err); else resolve(tokenizer);
      });
    });
  }
  return kuromojiTokenizerPromise;
};
// 🈂️ カタカナの読みをひらがなに変換する（ひらがな入力欄に合わせるため）
const katakanaToHiragana = (katakana: string): string =>
  katakana.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
// 🈂️ 氏名の1区切り（例：「斎内」）を辞書で解析し、読み（ひらがな）を推測する。
// 記号や未知語など読みが取れないトークンが1つでもあれば、誤った読みを作らないようnullを返す
const guessReadingWithKuromoji = async (text: string): Promise<string | null> => {
  const trimmed = text.trim();
  if (!trimmed) return '';
  try {
    const tokenizer = await getKuromojiTokenizer();
    const tokens = tokenizer.tokenize(trimmed);
    if (tokens.length === 0 || tokens.some(t => !t.reading)) return null;
    return katakanaToHiragana(tokens.map(t => t.reading || '').join(''));
  } catch (e) {
    console.error('氏名の読みの自動推測に失敗しました:', e);
    return null;
  }
};

// 🈂️ 氏名を空白区切りの文節に分割する（例：「山田 太郎 様」→ [{text:'山田',...}, {text:'太郎',...}]）。
// 末尾の文節が敬称「様」だけの場合は、ふりがな文節とは対応しないため除外する
const splitNameIntoSegments = (name: string): { text: string; start: number; end: number }[] => {
  const segments: { text: string; start: number; end: number }[] = [];
  const regex = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(name))) {
    segments.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  if (segments.length > 1 && segments[segments.length - 1].text === '様') {
    segments.pop();
  }
  return segments;
};

// 🈂️ 編集前・編集後の氏名を「文節」単位で比較し、どの文節が変わったかを判定する。
// 文字単位のprefix/suffix比較だと、「様」という共通の末尾や、たまたま同じ漢字（例：太郎→一郎の「郎」）に
// 引きずられて誤判定することがあるため、文節ごとのテキスト全体が一致するかどうかで比較する。
// 先頭から一致する文節数（prefixLen）と末尾から一致する文節数（suffixLen）を数え、その間（重なっていない部分）が
// 実際に変わった範囲とみなす。これにより「山田」だけだった氏名に「太郎」を書き足す（文節が増える）ような
// 編集でも、既存の文節（やまだ）のふりがなを消さずに新しい文節だけを挿入できる。
// - 先頭・末尾のどちらにも一致がない（全く別物） → 氏名欄を丸ごと打ち直したとみなす（'whole'）
//   ただし、旧氏名がそのまま新氏名の先頭または末尾にスペースなしでくっついて残っている場合
//   （例：「山田」の直後にスペースを打たずに続けて「花子」を打ち足し「山田花子」になった）は、
//   既存の文節を書き替えたわけではないので、末尾／先頭に新しい文節を追加しただけとみなす
//   （'appendAtEnd' / 'prependAtStart'）。これにより、スペースの打ち忘れで氏名欄全体が
//   打ち直し扱いになり、既存の文節のふりがなが消えてしまうことを防ぐ
// - 変わった範囲が旧側・新側ともにちょうど1文節ずつ → その文節を差し替える（'replaceSegment'）
// - 変わった範囲が旧側0・新側1文節（文節が増えた） → その位置に新しい文節を挿入する（'insertSegment'）
// - 変わった範囲が旧側1・新側0文節（文節が減った） → その位置の文節を削除する（'removeSegment'）
// - それ以外（複数の文節が入り乱れて変わった等） → 誤った読みを作らないよう判定しない（'ambiguous'）
type NameEditKind =
  | { kind: 'whole' }
  | { kind: 'appendAtEnd' }
  | { kind: 'prependAtStart' }
  | { kind: 'replaceSegment'; index: number }
  | { kind: 'insertSegment'; index: number }
  | { kind: 'removeSegment'; index: number }
  | { kind: 'ambiguous' };
const classifyNameEdit = (oldName: string, newName: string): NameEditKind => {
  const oldTexts = splitNameIntoSegments(oldName).map(seg => seg.text);
  const newTexts = splitNameIntoSegments(newName).map(seg => seg.text);
  if (oldTexts.length === 0) return { kind: 'whole' };

  let prefixLen = 0;
  const maxPrefix = Math.min(oldTexts.length, newTexts.length);
  while (prefixLen < maxPrefix && oldTexts[prefixLen] === newTexts[prefixLen]) prefixLen++;

  let suffixLen = 0;
  const maxSuffix = Math.min(oldTexts.length, newTexts.length) - prefixLen;
  while (
    suffixLen < maxSuffix &&
    oldTexts[oldTexts.length - 1 - suffixLen] === newTexts[newTexts.length - 1 - suffixLen]
  ) suffixLen++;

  if (prefixLen === 0 && suffixLen === 0) {
    if (newName.length > oldName.length && newName.startsWith(oldName)) return { kind: 'appendAtEnd' };
    if (newName.length > oldName.length && newName.endsWith(oldName)) return { kind: 'prependAtStart' };
    return { kind: 'whole' };
  }

  const oldChangedCount = oldTexts.length - prefixLen - suffixLen;
  const newChangedCount = newTexts.length - prefixLen - suffixLen;
  if (oldChangedCount === 1 && newChangedCount === 1) return { kind: 'replaceSegment', index: prefixLen };
  if (oldChangedCount === 0 && newChangedCount === 1) return { kind: 'insertSegment', index: prefixLen };
  if (oldChangedCount === 1 && newChangedCount === 0) return { kind: 'removeSegment', index: prefixLen };
  return { kind: 'ambiguous' };
};

// ==========================================
// 3. メインコンポーネント
// ==========================================
export default function OnCallApp() {
  // 🔒 認証用ステート
  // ⚠️ サーバー側では sessionStorage が存在しないため、初期値は必ずサーバー・クライアントで同じ（false）にする。
  // ここで直接 sessionStorage を読むと、サーバーが描画したHTMLとクライアントの内容が食い違い、
  // 「Hydration failed」エラー（クリックしても反応しない・状態が更新されないなど不可解な症状の原因）を引き起こすため、
  // マウント後に useEffect で読み込むようにしている。
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  // 👤 スタッフ管理：ログインできるID・パスワードの一覧（元は jam/yuki123 の1件だけハードコードされていたものを、
  // 管理画面から増やせるようにした）。初期値は既存ログインが壊れないよう常にjamを含める。
  // ⚠️ このアプリのログインは実際のセキュリティではなくクライアント側の操作抑止に過ぎないため、パスワードも
  // 平文のまま保持・表示する（CLAUDE.mdの「Auth is not real security」を参照）
  const DEFAULT_STAFF_ACCOUNTS: StaffAccount[] = [{ name: '', id: 'jam', password: 'yuki123' }];
  const [staffAccounts, setStaffAccounts] = useState<StaffAccount[]>(DEFAULT_STAFF_ACCOUNTS);
  const [isStaffAccountsRestored, setIsStaffAccountsRestored] = useState(false);
  React.useEffect(() => {
    if (typeof window === 'undefined') { setIsStaffAccountsRestored(true); return; }
    try {
      const saved = localStorage.getItem('oncall_staff_accounts');
      if (saved) {
        const parsed = JSON.parse(saved) as StaffAccount[];
        const isValid = Array.isArray(parsed) && parsed.length > 0 &&
          parsed.every(a => a && typeof a.id === 'string' && typeof a.password === 'string');
        // 🕒 氏名欄を後から追加したため、氏名を持たない古い保存データにはnameを補って読み込む
        if (isValid) setStaffAccounts(parsed.map(a => ({ name: typeof a.name === 'string' ? a.name : '', id: a.id, password: a.password })));
      }
    } catch (e) {
      console.error('スタッフID一覧の復元に失敗しました:', e);
    }
    setIsStaffAccountsRestored(true);
  }, []);
  React.useEffect(() => {
    if (!isStaffAccountsRestored) return;
    if (typeof window === 'undefined') return;
    localStorage.setItem('oncall_staff_accounts', JSON.stringify(staffAccounts));
  }, [staffAccounts, isStaffAccountsRestored]);

  const [isStaffAccountManagerOpen, setIsStaffAccountManagerOpen] = useState(false);
  const [newStaffName, setNewStaffName] = useState('');
  const [newStaffId, setNewStaffId] = useState('');
  const [newStaffPassword, setNewStaffPassword] = useState('');
  // 🔒 スタッフ管理画面を開く時にも、他の管理者操作と同様に管理者パスワードを必須にする
  //    （ログインできる人を増減できる操作のため）
  const handleOpenStaffAccountManager = () => {
    const MASTER_PASSWORD = 'master999';
    const inputPassword = prompt('⚠️ スタッフ管理には管理者パスワードが必要です。\nパスワードを入力してください：');
    if (inputPassword === null) return;
    if (inputPassword !== MASTER_PASSWORD) {
      alert('❌ パスワードが正しくありません。操作は取り消されました。');
      return;
    }
    setNewStaffName('');
    setNewStaffId('');
    setNewStaffPassword('');
    setIsStaffAccountManagerOpen(true);
  };
  const handleAddStaffAccount = () => {
    const name = newStaffName.trim();
    const id = newStaffId.trim();
    const pw = newStaffPassword.trim();
    if (!name || !id || !pw) {
      alert('氏名・ID・パスワードのすべてを入力してください。');
      return;
    }
    if (staffAccounts.some(acc => acc.id === id)) {
      alert('そのIDはすでに使われています。');
      return;
    }
    setStaffAccounts(prev => [...prev, { name, id, password: pw }]);
    setNewStaffName('');
    setNewStaffId('');
    setNewStaffPassword('');
  };
  const handleDeleteStaffAccount = (id: string) => {
    if (staffAccounts.length <= 1) {
      alert('最後の1件は削除できません。');
      return;
    }
    if (!window.confirm(`ID「${id}」を削除します。よろしいですか？`)) return;

    // 🔒 誤操作防止のため、削除にも管理者パスワードを必須にする（他の破壊的操作と同様）
    const MASTER_PASSWORD = 'master999';
    const inputPassword = prompt('⚠️ スタッフの削除には管理者パスワードが必要です。\nパスワードを入力してください：');
    if (inputPassword === null) return;
    if (inputPassword !== MASTER_PASSWORD) {
      alert('❌ パスワードが正しくありません。操作は取り消されました。');
      return;
    }

    setStaffAccounts(prev => prev.filter(acc => acc.id !== id));
  };

  // 🔒 現在ログイン中のユーザーID（レ点実施者の記録に自動で使う。リロードしても保持されるようセッションに保存）
  const [loggedInUser, setLoggedInUser] = useState<string>('');

  // 🗓️ 画面右上に常時表示する暦。サーバー描画・マウント直後は空文字（ハイドレーション不一致を避けるため）にし、
  // マウント（ログイン）した時点の日本時間で1回だけ計算する。日をまたいでタブを開きっぱなしにしても、
  // 次にログイン（再読み込み）するまでは「ログインした日」のまま表示し続ける（自動では切り替わらない）
  const [todayLabel, setTodayLabel] = useState<string>('');
  React.useEffect(() => {
    setTodayLabel(formatJstTodayLabel());
  }, []);
  // 📅 業務連絡シートの「作成する日にち」も、マウント時（ログイン時）はログインした日をデフォルトにする
  React.useEffect(() => {
    setHandoverCreationDate(getTodayISO());
  }, []);

  // 📦 物品管理の請求シート印刷時に、宛先として上部に表示するクリニック名。一度入力した名前は履歴として
  // 保存し、次回以降は氏名欄（旧「医療物品・バルン交換管理」の位置）をクリックすると一覧から選び直せる
  // （初回は履歴が空なので何も表示されない）
  const [clinicName, setClinicName] = useState<string>('');
  const [clinicNameHistory, setClinicNameHistory] = useState<string[]>([]);
  // 📦 クリニック名の右に付ける敬称。「御中」を自動で付け、▼で「様」「先生」にも切り替えられる
  const [clinicHonorific, setClinicHonorific] = useState<'御中' | '様' | '先生'>('御中');
  const handleClinicHonorificChange = (value: '御中' | '様' | '先生') => {
    setClinicHonorific(value);
    if (typeof window !== 'undefined') localStorage.setItem('oncall_clinic_honorific', value);
  };
  // 🈂️ クリック（フォーカス）すると履歴の一覧を出す自前のドロップダウン。ブラウザ標準のdatalistは
  // 「クリックしただけでは候補が出ない」端末・ブラウザがあり確実に選択方式にならないため使わない
  const [isClinicHistoryOpen, setIsClinicHistoryOpen] = useState(false);
  const handleClinicNameBlur = () => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('oncall_clinic_name', clinicName);
    const trimmed = clinicName.trim();
    if (trimmed && !clinicNameHistory.includes(trimmed)) {
      const nextHistory = [trimmed, ...clinicNameHistory].slice(0, 10);
      setClinicNameHistory(nextHistory);
      localStorage.setItem('oncall_clinic_name_history', JSON.stringify(nextHistory));
    }
  };
  // ✏️ 担当医療機関の履歴一覧から、不要になった1件だけを削除する
  const handleDeleteClinicNameHistory = (name: string) => {
    const nextHistory = clinicNameHistory.filter(h => h !== name);
    setClinicNameHistory(nextHistory);
    if (typeof window !== 'undefined') {
      localStorage.setItem('oncall_clinic_name_history', JSON.stringify(nextHistory));
    }
  };

  // 📦 物品管理の請求月（YYYY-MM）。クリニック名の右にある表示の左右の矢印で月を送るか、
  // 表示自体をクリックするとカレンダーが開き、日を選んで月を切り替えることもできる。
  // 未設定（サーバー描画時・マウント直後）は空文字のまま＝「未設定」と表示し、マウント後に
  // 保存済みの値、無ければ今月をセットする（ハイドレーション不一致を避けるため）
  const [billingMonth, setBillingMonth] = useState<string>('');
  // 📦 物品管理のデータ（患者ごとの物品一覧・共通物品）が「実際に今どの月の内容を表しているか」を覚えておく値。
  // ◀▶は請求月の表示（billingMonth）を自由に前後させられるが、それだけでは実データは動かない。
  // すでに翌月へ進めた月まで◀で戻ってから▶で戻ろうとした時、二重に繰り上げ処理をしてデータを壊さないよう、
  // 「本当にまだ繰り上げていない、今のデータの月」と表示中の月が一致する時だけ繰り上げ処理を行うために使う
  const [supplyLiveMonth, setSupplyLiveMonth] = useState<string>('');
  // 🗓️ 物品管理の請求シートに記載する「印刷日」（YYYY-MM-DD）。右上の暦（todayLabel）と同じく、
  // ログインした日を毎回そのまま表示するだけの情報表示で、選び直すことはできない
  const [supplyPrintDate, setSupplyPrintDate] = useState<string>('');
  // 🗓️ 物品（特に臨時）の「作成日」。クリニックへ送る文書に、いつの物品が欲しいのかを明記するために
  // 定期履歴・臨時履歴の横のカレンダーで選び直せるようにする。印刷にも大きめに反映される
  // （未設定＝マウント直後は空文字にし、マウント後にログインした日をデフォルトにする。ハイドレーション不一致を避けるため）
  const [supplyItemCreationDate, setSupplyItemCreationDate] = useState<string>('');
  const [isSupplyItemCreationDateCalendarOpen, setIsSupplyItemCreationDateCalendarOpen] = useState(false);
  const [supplyItemCreationDateCalendarViewMonth, setSupplyItemCreationDateCalendarViewMonth] = useState<string>('');
  const openSupplyItemCreationDateCalendar = () => {
    setSupplyItemCreationDateCalendarViewMonth((supplyItemCreationDate || getTodayISO()).slice(0, 7));
    setIsSupplyItemCreationDateCalendarOpen(prev => !prev);
  };
  const shiftSupplyItemCreationDateCalendarMonth = (deltaMonths: number) => {
    setSupplyItemCreationDateCalendarViewMonth(prev => shiftMonthISO(prev || getTodayISO().slice(0, 7), deltaMonths));
  };
  const handleSelectSupplyItemCreationDate = (iso: string) => {
    setSupplyItemCreationDate(iso);
    setIsSupplyItemCreationDateCalendarOpen(false);
    if (typeof window !== 'undefined') localStorage.setItem('oncall_supply_item_creation_date', iso);
  };
  // 📝 「請求物品」欄の下に書けるメモ（クリニックへの伝達事項など）。印刷にも反映される。
  //    月（billingMonth）ごとに別々のメモを持つ（他の月・他のページには反映されないようにするため）
  const [supplyBillingMemoByMonth, setSupplyBillingMemoByMonth] = useState<Record<string, string>>({});
  // 📦 「新規作成」ボタンを押している間だけ、請求月の◀🗓️▶（月を進める・戻す）と、
  //    氏名（ダブルクリックで追加）・▼氏名を選んで物品を追加、を中央に表示する。
  //    普段は一覧をシンプルに保つため、これらの操作エリアは隠しておく
  const [isSupplyNewCreationOpen, setIsSupplyNewCreationOpen] = useState(false);
  // 📦 「新規作成」「臨時作成」どちらのボタンで開いたか。氏名を選んだ時に作る物品の区分（定数／臨時）に使う
  const [supplyNewCreationKind, setSupplyNewCreationKind] = useState<'定数' | '臨時'>('定数');
  // 📦 定期作成を押した直後、「先月の定数を引き継いで作成」「新規作成」のどちらで進めるかをまず選んでもらう
  const [isSupplyFixedCreationChoiceOpen, setIsSupplyFixedCreationChoiceOpen] = useState(false);
  // 📦 部屋図・業務連絡などから物品管理へ移動するたびに、まず「作成する／履歴をみる」だけを選ばせる。
  // null＝選択前（クリニック名や一覧はまだ何も出さない）、'create'＝これまでの作成画面、
  // 'history'＝定期履歴▼・臨時履歴▼のドロップダウンだけを表示する
  const [supplyEntryChoice, setSupplyEntryChoice] = useState<'create' | 'history' | null>(null);
  // 📱 履歴▼のドロップダウンは、マウスを乗せると開く（group-hover）だけだとiPhoneなど指で操作する端末では
  //    開けないため、タップでも開閉できるようにする。どのメニューが開いているか（無ければnull）。
  //    メニュー外をタップした時は閉じる（iOSはclickがbodyまで届かないことがあるためpointerdownで判定）
  const [openHistoryMenu, setOpenHistoryMenu] = useState<string | null>(null);
  React.useEffect(() => {
    if (!openHistoryMenu) return;
    const closeOnOutsidePointer = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest('[data-history-toggle], [data-history-menu]')) return;
      setOpenHistoryMenu(null);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [openHistoryMenu]);
  // 🖨️ 物品管理の印刷：「在庫を含めて印刷」「在庫を除いて印刷」の2つのボタンを用意する。
  //    在庫を除く場合は、在庫の列だけ印刷時に隠すクラス（no-print）を付けた状態にしてから印刷を開く。
  //    setStateは非同期のため、押した瞬間にwindow.print()を呼ぶとまだ古い表示のまま印刷されてしまう。
  //    そのため一度カウンタだけを進め、再描画が終わってから（useEffect側で）印刷を開くようにしている
  const [supplyPrintHideStock, setSupplyPrintHideStock] = useState(false);
  const [supplyPrintTrigger, setSupplyPrintTrigger] = useState(0);
  const handlePrintSupplySheet = (hideStock: boolean) => {
    setSupplyPrintHideStock(hideStock);
    setSupplyPrintTrigger(n => n + 1);
  };
  React.useEffect(() => {
    if (supplyPrintTrigger === 0) return;
    window.print();
  }, [supplyPrintTrigger]);

  // 🩺 緊急時対応サマリーシートの「かかりつけ医」「救急搬送希望先」の入力履歴（クリックすると選び直せる一覧の元データ）。
  // 状態の宣言・復元はここで行い、実際の読み書きロジック（handlePrimaryDoctorBlur等）はsummaryDraftの近くにまとめている
  const [primaryDoctorHistory, setPrimaryDoctorHistory] = useState<PrimaryDoctorHistoryEntry[]>([]);
  const [isPrimaryDoctorHistoryOpen, setIsPrimaryDoctorHistoryOpen] = useState(false);
  const [emergencyHospitalHistory, setEmergencyHospitalHistory] = useState<EmergencyHospitalHistoryEntry[]>([]);
  const [isEmergencyHospitalHistoryOpen, setIsEmergencyHospitalHistoryOpen] = useState(false);
  // ✏️ かかりつけ医・救急搬送希望先の履歴一覧を、その場（ドロップダウン内）で編集中の1件（idで特定）と、
  // その編集中の入力内容。新規に1件追加する時の入力欄も、メインの氏名欄とは別にここで保持する
  const [editingPrimaryDoctorHistoryId, setEditingPrimaryDoctorHistoryId] = useState<string | null>(null);
  const [primaryDoctorHistoryEditDraft, setPrimaryDoctorHistoryEditDraft] = useState<Omit<PrimaryDoctorHistoryEntry, 'id'>>({ clinic: '', name: '', postalCode: '', address: '', tel: '' });
  const [newPrimaryDoctorEntryDraft, setNewPrimaryDoctorEntryDraft] = useState<Omit<PrimaryDoctorHistoryEntry, 'id'>>({ clinic: '', name: '', postalCode: '', address: '', tel: '' });
  const [editingEmergencyHospitalHistoryId, setEditingEmergencyHospitalHistoryId] = useState<string | null>(null);
  const [emergencyHospitalHistoryEditDraft, setEmergencyHospitalHistoryEditDraft] = useState<Omit<EmergencyHospitalHistoryEntry, 'id'>>({ name: '', postalCode: '', address: '', tel: '' });
  const [newEmergencyHospitalEntryDraft, setNewEmergencyHospitalEntryDraft] = useState<Omit<EmergencyHospitalHistoryEntry, 'id'>>({ name: '', postalCode: '', address: '', tel: '' });

  // 🔤 クリニック名・かかりつけ医（医院名）・救急搬送希望先（病院名）は、内服薬などと違って漢字の名称が
  // ほとんどのため、通常の文字列比較（localeCompare）では正しい「あいうえお順」に並ばない
  // （JavaScriptは漢字の読み方を知らないため、見た目上ランダムに近い順序になってしまう）。
  // そこで、氏名のふりがな自動入力と同じkuromoji（ローカル辞書・通信/課金なし）で読みを推測して
  // キャッシュしておき、実際の読み方の順に並べ替えられるようにする
  const [historyReadingCache, setHistoryReadingCache] = useState<Record<string, string>>({});
  const ensureReadingsForTexts = (texts: string[]) => {
    const targets = Array.from(new Set(texts.map(t => t.trim()).filter(Boolean)))
      .filter(t => !(t in historyReadingCache));
    targets.forEach(t => {
      guessReadingWithKuromoji(t).then(reading => {
        if (reading === null) return;
        setHistoryReadingCache(prev => (t in prev ? prev : { ...prev, [t]: reading }));
      });
    });
  };
  React.useEffect(() => {
    ensureReadingsForTexts(clinicNameHistory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicNameHistory]);
  React.useEffect(() => {
    ensureReadingsForTexts(primaryDoctorHistory.map(h => h.clinic || h.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryDoctorHistory]);
  React.useEffect(() => {
    ensureReadingsForTexts(emergencyHospitalHistory.map(h => h.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emergencyHospitalHistory]);
  // 🔤 上記の読みキャッシュを使って、実際の読み方の「あいうえお順」で並べ替える（読みが未取得の間は元の文字列で仮に並べる）
  const sortByGuessedReading = <T,>(list: T[], toText: (item: T) => string): T[] =>
    sortJaAsc(list, item => {
      const text = toText(item).trim();
      return historyReadingCache[text] || text;
    });

  // 💊 緊急時対応サマリーシートの「内服薬」「禁忌薬」「感染症有無」の入力履歴（クリックすると、あいうえお順に
  // 並んだ一覧から選び直せる。いずれも1項目＝1欄のリスト形式のため、開いている行のidで開閉を管理する）
  const [medicationHistory, setMedicationHistory] = useState<{ name: string; dosageTiming: string }[]>([]);
  const [openMedicationHistoryId, setOpenMedicationHistoryId] = useState<string | null>(null);
  const [contraindicatedMedicationHistory, setContraindicatedMedicationHistory] = useState<string[]>([]);
  const [openContraindicatedHistoryId, setOpenContraindicatedHistoryId] = useState<string | null>(null);
  const [infectionStatusHistory, setInfectionStatusHistory] = useState<string[]>([]);
  const [openInfectionHistoryId, setOpenInfectionHistoryId] = useState<string | null>(null);

  // 📢 業務連絡シート：保存ボタンを押すまではlocalStorageに反映されない下書き扱い
  // （savedHandoverNoteは最後に保存された内容。handoverNoteと差があれば「未保存」の目印を出す）
  const DEFAULT_HANDOVER_NOTE = `【全体連絡】本日大きなトラブルなし。よろしくお願いいたします。`;
  // 📅 まだ来ていない未来日（翌日）向けに、記録の無い状態から書き始める時のひな形文。
  //    記載漏れを防ぐため、その日が来る前でも事前に書き込めることを案内する
  const DEFAULT_HANDOVER_NOTE_FUTURE = `記載漏れ防止のため事前に書き込みを記入可能です。`;
  const [handoverNote, setHandoverNote] = useState<string>(DEFAULT_HANDOVER_NOTE);
  const [savedHandoverNote, setSavedHandoverNote] = useState<string>(DEFAULT_HANDOVER_NOTE);
  const [handoverNoteSavedBy, setHandoverNoteSavedBy] = useState<string>('');
  const [handoverNoteSavedAt, setHandoverNoteSavedAt] = useState<string>('');
  // 📅 最後に保存した業務連絡が「どの作成日」向けだったか。翌日になってログインした時に、
  //    その日が来たかどうかを判定するために保存内容と一緒に保持しておく
  const [savedHandoverNoteDate, setSavedHandoverNoteDate] = useState<string>('');
  // ✅ 未来の日付向けに保存した内容がまだ「確定」されていないか。falseの間は文字を薄いグレーで表示し、
  //    その日になってログインした時に「確定しますか？」の確認を表出する
  const [handoverNoteConfirmed, setHandoverNoteConfirmed] = useState<boolean>(true);
  const [isHandoverConfirmPromptOpen, setIsHandoverConfirmPromptOpen] = useState(false);
  // 📜 業務連絡シートの日付ごとの履歴（保存するたびに、その時点の「作成日」をキーとして、内容・保存日時・
  //    保存したログインユーザー名を記録する。同じ日付を選び直した時はこの記録を読み込んで続きから編集する
  //    ことで、同じ日付のシートを二重に作ってしまうことを防ぐ）
  const [handoverNoteArchive, setHandoverNoteArchive] = useState<Record<string, { text: string; savedAt: string; savedBy: string }>>({});
  // 📜 履歴▼から過去の日を選んで閲覧中の場合はその日（YYYY-MM-DD）、通常の編集画面ならnull
  const [viewingHandoverArchiveDate, setViewingHandoverArchiveDate] = useState<string | null>(null);
  // 📅 業務連絡シートの「作成する日にち」。右上の暦（ログインした日・todayLabel）とは別で、
  // カレンダーで選び直したり▶で1日ずつ進めたりできる（未設定＝マウント直後は空文字にし、
  // マウント後にログインした日をデフォルトにする。ハイドレーション不一致を避けるため）
  const [handoverCreationDate, setHandoverCreationDate] = useState<string>('');
  const [isHandoverDateCalendarOpen, setIsHandoverDateCalendarOpen] = useState(false);
  const [handoverDateCalendarViewMonth, setHandoverDateCalendarViewMonth] = useState<string>('');
  const openHandoverDateCalendar = () => {
    setHandoverDateCalendarViewMonth((handoverCreationDate || getTodayISO()).slice(0, 7));
    setIsHandoverDateCalendarOpen(prev => !prev);
  };
  const shiftHandoverDateCalendarMonth = (deltaMonths: number) => {
    setHandoverDateCalendarViewMonth(prev => shiftMonthISO(prev || getTodayISO().slice(0, 7), deltaMonths));
  };
  // 📅 業務連絡シートの「作成日」は、ログインした日の翌日までしか選べない（それより先の未来日は作成不可）
  const getHandoverMaxDate = (): string => {
    const d = new Date(`${getTodayISO()}T00:00:00`);
    d.setDate(d.getDate() + 1);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  };
  // 📅 作成日を選び直す。すでにその日付で保存済みの記録があれば読み込んで続きから編集できるようにし、
  //    まだ無ければ真っ白な状態から作成できるようにする（同じ日付のシートを二重に作ることを防ぐ）
  const handleSelectHandoverDate = (iso: string) => {
    if (iso > getHandoverMaxDate()) return;
    setHandoverCreationDate(iso);
    setIsHandoverDateCalendarOpen(false);
    const archived = handoverNoteArchive[iso];
    if (archived) {
      setHandoverNote(archived.text);
      setSavedHandoverNote(archived.text);
      setHandoverNoteSavedBy(archived.savedBy);
      setHandoverNoteSavedAt(archived.savedAt);
    } else if (iso > getTodayISO()) {
      // 📅 未来日はまだ何も書かれていない状態にし、案内文はプレースホルダーとして表示する
      //    （実際に文字を入力すれば自然に消える、入力欄本来のプレースホルダー扱いにする）
      setHandoverNote('');
      setSavedHandoverNote('');
      setHandoverNoteSavedBy('');
      setHandoverNoteSavedAt('');
    } else {
      setHandoverNote(DEFAULT_HANDOVER_NOTE);
      setSavedHandoverNote(DEFAULT_HANDOVER_NOTE);
      setHandoverNoteSavedBy('');
      setHandoverNoteSavedAt('');
    }
  };
  // 🎨 未来日向けにまだ確定されていない内容は薄いグレーで表示する（今まさに未来日を選んで入力中の場合も含む）。
  //    handoverNoteConfirmedは「最後に保存した内容」1件分の確定状態なので、今まさに画面に出ている日付
  //    （handoverCreationDate）が、その保存された日付（savedHandoverNoteDate）と一致する時だけ見る。
  //    そうしないと、別の未来日を保存した後に今日の画面へ戻っただけで今日の文字までグレーになってしまう
  const isHandoverNoteFutureGray = handoverCreationDate > getTodayISO()
    || (handoverCreationDate === savedHandoverNoteDate && !handoverNoteConfirmed);

  // 🔒 マウント後（クライアント側のみ）にセッション情報を読み込み、ログイン状態を復元する
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (sessionStorage.getItem('oncall_auth') === 'true') {
      setIsAuthenticated(true);
    }
    const savedUser = sessionStorage.getItem('oncall_user');
    if (savedUser) {
      setLoggedInUser(savedUser);
    }
    // 🗓️ 保存済みの往診日を復元する（リロードしても消えないように）
    const savedVisitDate = localStorage.getItem('oncall_next_visit_date');
    if (savedVisitDate) {
      setNextVisitDate(savedVisitDate);
    }
    // 📢 保存済みの業務連絡シートを復元する（保存ボタンを押した内容のみ。再ログインしても消えないように）
    const savedHandoverNote = localStorage.getItem('oncall_handover_note');
    if (savedHandoverNote !== null) {
      setHandoverNote(savedHandoverNote);
      setSavedHandoverNote(savedHandoverNote);
    }
    const savedHandoverNoteSavedBy = localStorage.getItem('oncall_handover_note_saved_by');
    if (savedHandoverNoteSavedBy) {
      setHandoverNoteSavedBy(savedHandoverNoteSavedBy);
    }
    const savedHandoverNoteSavedAt = localStorage.getItem('oncall_handover_note_saved_at');
    if (savedHandoverNoteSavedAt) {
      setHandoverNoteSavedAt(savedHandoverNoteSavedAt);
    }
    // 📅 業務連絡シートが「未来日向け・未確定」のまま保存されていないか確認する。
    //    その未来日が今日（ログインした日）になっていれば「確定しますか？」を表出する
    const savedHandoverNoteDate = localStorage.getItem('oncall_handover_note_date') || '';
    setSavedHandoverNoteDate(savedHandoverNoteDate);
    const confirmedFlag = localStorage.getItem('oncall_handover_note_confirmed') !== 'false';
    setHandoverNoteConfirmed(confirmedFlag);
    if (!confirmedFlag && savedHandoverNoteDate && savedHandoverNoteDate <= getTodayISO()) {
      setIsHandoverConfirmPromptOpen(true);
    }
    // 📜 保存済みの業務連絡シートの日付ごとの履歴を復元する
    const savedHandoverNoteArchive = localStorage.getItem('oncall_handover_note_archive');
    if (savedHandoverNoteArchive) {
      try {
        const parsed = JSON.parse(savedHandoverNoteArchive);
        if (parsed && typeof parsed === 'object') {
          // 🔄 保存日時・氏名を記録する前の旧形式（文字列のみ）のデータも読み込めるようにする
          const normalized: Record<string, { text: string; savedAt: string; savedBy: string }> = Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>).map(([date, value]) => [
              date,
              typeof value === 'string' ? { text: value, savedAt: '', savedBy: '' } : value as { text: string; savedAt: string; savedBy: string },
            ])
          );
          setHandoverNoteArchive(normalized);
          // 🗓️ 今日（ログインした日）向けの記録が既にあれば、フラットキャッシュより優先して読み込み、
          //    続きから編集できるようにする（フラットキャッシュは最後に保存した日付とズレることがあるため）
          const todaysArchived = normalized[getTodayISO()];
          if (todaysArchived) {
            setHandoverNote(todaysArchived.text);
            setSavedHandoverNote(todaysArchived.text);
            setHandoverNoteSavedBy(todaysArchived.savedBy);
            setHandoverNoteSavedAt(todaysArchived.savedAt);
          }
        }
      } catch (e) {
        console.error('業務連絡シートの履歴の復元に失敗しました:', e);
      }
    }
    // 📦 保存済みのクリニック名・入力履歴を復元する
    const savedClinicName = localStorage.getItem('oncall_clinic_name');
    if (savedClinicName) {
      setClinicName(savedClinicName);
    }
    const savedClinicHonorific = localStorage.getItem('oncall_clinic_honorific');
    if (savedClinicHonorific === '御中' || savedClinicHonorific === '様' || savedClinicHonorific === '先生') {
      setClinicHonorific(savedClinicHonorific);
    }
    const savedClinicNameHistory = localStorage.getItem('oncall_clinic_name_history');
    if (savedClinicNameHistory) {
      try {
        const parsed = JSON.parse(savedClinicNameHistory);
        if (Array.isArray(parsed)) setClinicNameHistory(parsed);
      } catch (e) {
        console.error('クリニック名履歴の復元に失敗しました:', e);
      }
    }
    // 📦 保存済みの「共通物品」一覧を復元する
    const savedCommonSupplies = localStorage.getItem('oncall_common_supplies');
    if (savedCommonSupplies) {
      try {
        const parsed = JSON.parse(savedCommonSupplies);
        if (Array.isArray(parsed)) setCommonSupplies(parsed.map(migrateSupplyItem));
      } catch (e) {
        console.error('共通物品の復元に失敗しました:', e);
      }
    }
    // 📦 保存済みの物品管理「翌月に進む」の月別履歴を復元する
    // 🧹 ご依頼により、これまで溜まっていた月別履歴（例：2026年8月など）を一度だけ消去する。
    //    このフラグが付いた後は、通常通り新しく積み上がる履歴を復元・保存する
    const archiveResetFlag = 'oncall_supply_archive_reset_20260917';
    if (!localStorage.getItem(archiveResetFlag)) {
      localStorage.removeItem('oncall_supply_monthly_archive');
      localStorage.setItem(archiveResetFlag, '1');
    } else {
      const savedSupplyArchive = localStorage.getItem('oncall_supply_monthly_archive');
      if (savedSupplyArchive) {
        try {
          const parsed = JSON.parse(savedSupplyArchive);
          if (parsed && typeof parsed === 'object') setSupplyMonthlyArchive(parsed);
        } catch (e) {
          console.error('物品管理の月別履歴の復元に失敗しました:', e);
        }
      }
    }
    // 📦 保存済みの物品管理「臨時履歴」（保存した日ごとの記録）を復元する
    const savedSupplyTemporaryArchive = localStorage.getItem('oncall_supply_temporary_archive');
    if (savedSupplyTemporaryArchive) {
      try {
        const parsed = JSON.parse(savedSupplyTemporaryArchive);
        if (parsed && typeof parsed === 'object') setSupplyTemporaryArchive(parsed);
      } catch (e) {
        console.error('物品管理の臨時履歴の復元に失敗しました:', e);
      }
    }
    // 📦 保存済みの物品管理「臨時作成」の最終保存日時・実施者を復元する
    const savedSupplyTemporaryLastSavedAt = localStorage.getItem('oncall_supply_temporary_last_saved_at');
    if (savedSupplyTemporaryLastSavedAt) setSupplyTemporaryLastSavedAt(savedSupplyTemporaryLastSavedAt);
    const savedSupplyTemporaryLastSavedBy = localStorage.getItem('oncall_supply_temporary_last_saved_by');
    if (savedSupplyTemporaryLastSavedBy) setSupplyTemporaryLastSavedBy(savedSupplyTemporaryLastSavedBy);
    // 🧹 これまでの動作確認中に、請求月（billingMonth）と物品管理の実データの月（supplyLiveMonth）が
    //    食い違ってしまい、氏名選択などが表示されなくなる不具合が繰り返し起きていたため、一度だけ
    //    両方を「今日の月」に強制的にそろえ直す。このフラグが付いた後は、通常通り保存済みの値を使う
    const liveMonthResetFlag = 'oncall_supply_live_month_reset_20260916';
    const todayMonth = getTodayISO().slice(0, 7);
    if (!localStorage.getItem(liveMonthResetFlag)) {
      setBillingMonth(todayMonth);
      setSupplyLiveMonth(todayMonth);
      if (typeof window !== 'undefined') {
        localStorage.setItem('oncall_billing_month', todayMonth);
        localStorage.setItem('oncall_supply_live_month', todayMonth);
        localStorage.setItem(liveMonthResetFlag, '1');
      }
    } else {
      // 📦 保存済みの請求月を復元する（無ければ今月をデフォルトにする）
      const savedBillingMonth = localStorage.getItem('oncall_billing_month') || todayMonth;
      setBillingMonth(savedBillingMonth);
      // 📦 保存済みの「物品管理の実データが表している月」を復元する（無ければ請求月に合わせる）
      setSupplyLiveMonth(localStorage.getItem('oncall_supply_live_month') || savedBillingMonth);
    }
    // 📦 物品管理：ログアウト（リロード）時点の「定期作成／臨時作成を開いていたかどうか・どちらの区分か」を
    //    復元する。これにより、画面に戻った時も何月分・定期か臨時かの表記がそのまま引き続き見える
    const savedSupplyNewCreationKind = localStorage.getItem('oncall_supply_new_creation_kind');
    if (savedSupplyNewCreationKind === '定数' || savedSupplyNewCreationKind === '臨時') {
      setSupplyNewCreationKind(savedSupplyNewCreationKind);
    }
    if (localStorage.getItem('oncall_supply_new_creation_open') === 'true') {
      setIsSupplyNewCreationOpen(true);
    }
    // 📦 物品管理シートの印刷日は、右上の暦（todayLabel）と同じく「ログインした日」を毎回デフォルトにする。
    //    以前の保存値をそのまま復元すると、日をまたいでも古い日付が表示され続けてしまうため
    setSupplyPrintDate(getTodayISO());
    // 🗓️ 物品の「作成日」は、選び直した値をそのまま復元する（無ければログインした日をデフォルトにする）
    setSupplyItemCreationDate(localStorage.getItem('oncall_supply_item_creation_date') || getTodayISO());
    // 📝 保存済みの請求物品メモ（月ごと）を復元する
    const savedSupplyBillingMemoByMonth = localStorage.getItem('oncall_supply_billing_memo_by_month');
    if (savedSupplyBillingMemoByMonth) {
      try {
        const parsed = JSON.parse(savedSupplyBillingMemoByMonth);
        if (parsed && typeof parsed === 'object') setSupplyBillingMemoByMonth(parsed);
      } catch (e) {
        console.error('請求物品メモの復元に失敗しました:', e);
      }
    }
    // 🩺 保存済みの「かかりつけ医」「救急搬送希望先」の入力履歴を復元する
    const savedPrimaryDoctorHistory = localStorage.getItem('oncall_primary_doctor_history');
    if (savedPrimaryDoctorHistory) {
      try {
        const parsed = JSON.parse(savedPrimaryDoctorHistory);
        // 🩺 その場で編集・削除できるようにidを追加した際、既存データにidが無ければここで割り振る
        if (Array.isArray(parsed)) setPrimaryDoctorHistory(parsed.map((h, i) => ({ id: h.id ?? `pdh_${i}_${Date.now()}`, ...h })));
      } catch (e) {
        console.error('かかりつけ医履歴の復元に失敗しました:', e);
      }
    }
    const savedEmergencyHospitalHistory = localStorage.getItem('oncall_emergency_hospital_history');
    if (savedEmergencyHospitalHistory) {
      try {
        const parsed = JSON.parse(savedEmergencyHospitalHistory);
        // 🚑 その場で編集・削除できるようにidを追加した際、既存データにidが無ければここで割り振る
        if (Array.isArray(parsed)) setEmergencyHospitalHistory(parsed.map((h, i) => ({ id: h.id ?? `ehh_${i}_${Date.now()}`, ...h })));
      } catch (e) {
        console.error('救急搬送希望先履歴の復元に失敗しました:', e);
      }
    }
    // 💊 保存済みの「内服薬」「禁忌薬」「感染症有無」の入力履歴を復元する
    const savedMedicationHistory = localStorage.getItem('oncall_medication_history');
    if (savedMedicationHistory) {
      try {
        const parsed = JSON.parse(savedMedicationHistory);
        if (Array.isArray(parsed)) setMedicationHistory(parsed);
      } catch (e) {
        console.error('内服薬履歴の復元に失敗しました:', e);
      }
    }
    const savedContraindicatedMedicationHistory = localStorage.getItem('oncall_contraindicated_medication_history');
    if (savedContraindicatedMedicationHistory) {
      try {
        const parsed = JSON.parse(savedContraindicatedMedicationHistory);
        if (Array.isArray(parsed)) setContraindicatedMedicationHistory(parsed);
      } catch (e) {
        console.error('禁忌薬履歴の復元に失敗しました:', e);
      }
    }
    const savedInfectionStatusHistory = localStorage.getItem('oncall_infection_status_history');
    if (savedInfectionStatusHistory) {
      try {
        const parsed = JSON.parse(savedInfectionStatusHistory);
        if (Array.isArray(parsed)) setInfectionStatusHistory(parsed);
      } catch (e) {
        console.error('感染症有無履歴の復元に失敗しました:', e);
      }
    }
  }, []);

  // 既存のステート
  const [currentView, setCurrentView] = useState<'map' | 'handover' | 'doctor' | 'summary' | 'supply'>('doctor');
  // 📦 部屋図・業務連絡などから物品管理へ移動するたびに、必ず「作成する／履歴をみる」の選択画面から
  //    やり直す。保存もキャンセルもせずに他の画面へ移ってしまった下書き（先月の引き継ぎプレビューなど）が
  //    残っていると、次に「作成する」を選んだ時にそれがそのまま出てきてしまうため、下書きと作成中の
  //    状態もあわせてリセットする（履歴をみる→記録を選んで編集、という同じ画面内の遷移では
  //    currentViewは変わらないため、ここでは影響しない）
  React.useEffect(() => {
    if (currentView !== 'supply') return;
    setSupplyEntryChoice(null);
    setSupplyDraft(null);
    setIsSupplyNewCreationOpen(false);
    setIsSupplyFixedCreationChoiceOpen(false);
    setContinuingSupplyMonthlyArchiveMonth(null);
    setDisplayedSupplyMonthlyArchiveMonth(null);
    setContinuingSupplyTemporaryArchiveKey(null);
    setDisplayedSupplyTemporaryArchiveKey(null);
    // 🧹 定期作成／臨時作成のどちらがハイライトされていたか、作成日カレンダーで選んだ日、
    //    途中まで開いていた氏名・物品の選択なども、前回の状態がそのまま見えてしまわないよう
    //    すべて初期状態に戻す（ボタン自体は消さず、見た目だけを毎回まっさらにする）
    setSupplyNewCreationKind('定数');
    setBillingMonth(getTodayISO().slice(0, 7));
    setSupplyItemCreationDate(getTodayISO());
    if (typeof window !== 'undefined') localStorage.setItem('oncall_supply_item_creation_date', getTodayISO());
    setIsSupplyItemCreationDateCalendarOpen(false);
    setIsSupplyPatientPickerOpen(false);
    setSupplyNewItemDraft(null);
    setIsSupplyKindPickerOpen(false);
    setSupplyCatalogView(false);
    setOpenSupplyDateCalendarKey(null);
  }, [currentView]);
  const [patients, setPatients] = useState<Patient[]>(initialPatients);

  // 💾 VS・医師連携：画面右上の「保存」ボタン。この画面の項目は入力するたびに自動でpatientsへ反映・保存されているが、
  // 操作し終わったタイミングで明示的に保存を確定させたい、という要望に応えるための確認・念押し用ボタン。
  // 画面を開いた時点のpatientsをスナップショットとして持っておき、まだ何も変わっていなければグレー、
  // 何か変更があれば緑にする（保存すると、そのスナップショットを今の内容で更新する）
  const [doctorScreenSavedSnapshot, setDoctorScreenSavedSnapshot] = useState<string>('');
  React.useEffect(() => {
    if (currentView === 'doctor') setDoctorScreenSavedSnapshot(JSON.stringify(patients));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentView]);
  const handleSaveDoctorScreen = () => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('oncall_patients_v3', JSON.stringify(patients));
      } catch (e) {
        console.error('保存に失敗しました:', e);
      }
    }
    setDoctorScreenSavedSnapshot(JSON.stringify(patients));
    alert('💾 保存しました');
  };

  // 🩺 VS・状態報告・医師指示：①③④を含めた4分割カルテではなく、②VS・状態報告・医師指示だけをクリニック宛の
  // 簡易帳票として印刷したい時に使う。ボタンを押すと一瞬だけこのモードの簡易レイアウトに切り替えて印刷し、
  // 印刷ダイアログが閉じたら通常の4分割編集画面へ自動的に戻す
  const [isVsPrintMode, setIsVsPrintMode] = useState(false);
  const handlePrintVsOnly = () => {
    setIsVsPrintMode(true);
    requestAnimationFrame(() => {
      window.print();
      setIsVsPrintMode(false);
    });
  };

  // 📦 共通物品：特定の入居者に紐づかない、施設共通の物品一覧（部屋図の入居者とは別に、独立して保存する）
  const [commonSupplies, setCommonSupplies] = useState<SupplyItem[]>([]);
  // 📦 「翌月に進む」で保存する、月ごとの物品スナップショット履歴（キーはYYYY-MM）。
  // クリックするとその月の記録を読み取り専用で表示できる
  const [supplyMonthlyArchive, setSupplyMonthlyArchive] = useState<Record<string, SupplyMonthlySnapshot>>({});
  // 📦 「臨時作成」で保存するたびに残る履歴（キーは実際に保存した日=YYYY-MM-DD）。
  //    臨時はひと月に何回も作成できるため、月単位ではなく保存した日ごとに分けて記録する
  const [supplyTemporaryArchive, setSupplyTemporaryArchive] = useState<Record<string, SupplyMonthlySnapshot>>({});
  // 📦 臨時作成を保存するたびに記録する「最終保存」日時・実施者。臨時作成エリアの左下に表示する
  const [supplyTemporaryLastSavedAt, setSupplyTemporaryLastSavedAt] = useState<string>('');
  const [supplyTemporaryLastSavedBy, setSupplyTemporaryLastSavedBy] = useState<string>('');
  // 📜 臨時履歴の記録を選んで「保存前と同じ画面（氏名▼選択・物品カタログなど）」で追加修正している最中の場合、
  //    そのキー（臨時履歴のentryKey）。この状態で保存すると、新しい記録を作らずこのキーへ上書きする
  const [continuingSupplyTemporaryArchiveKey, setContinuingSupplyTemporaryArchiveKey] = useState<string | null>(null);
  // 📜 今画面に表示されている臨時の内容が、臨時履歴のどの記録（entryKey）と対応しているか。
  //    新規作成・追加修正どちらで保存した後もここに記録しておき、履歴からその記録が削除された時に
  //    画面側（下書き）も一緒に消せるようにする（continuingSupplyTemporaryArchiveKeyとは別に持つ理由は、
  //    保存するたびに新しい記録を作る通常の臨時作成では、次の保存で上書きしないようcontinuing側は
  //    毎回nullへ戻す必要があるため）
  const [displayedSupplyTemporaryArchiveKey, setDisplayedSupplyTemporaryArchiveKey] = useState<string | null>(null);
  // 📜 定期履歴の記録を選んで「保存前と同じ画面」で追加修正している最中の場合、その月（YYYY-MM）。
  //    この月が「今の実データの月（supplyLiveMonth）」と違う場合は、過去の記録なので保存時に
  //    定期履歴だけを上書きし、現在進行中の実データ（patients・commonSupplies）には反映しない
  const [continuingSupplyMonthlyArchiveMonth, setContinuingSupplyMonthlyArchiveMonth] = useState<string | null>(null);
  // 📜 今画面（実データ）に表示されている定期の内容が、定期履歴のどの月と対応しているか。臨時履歴と
  //    同様に、新規作成・追加修正どちらで保存した後もここに記録し、その月の履歴が削除された時に
  //    実データ側の物品も一緒に消せるようにする
  const [displayedSupplyMonthlyArchiveMonth, setDisplayedSupplyMonthlyArchiveMonth] = useState<string | null>(null);

  // 📦 物品管理の下書き：緊急時対応サマリーシートと同じく「保存」ボタンを押すまでは変更を確定しない方式にするため、
  // 物品管理の画面を開いている間はここ（下書き）だけを書き換え、patients・commonSupplies（保存済みの実データ）は
  // 「保存」ボタンを押した時だけまとめて書き換える。patientSuppliesは患者idごとのsupplies一覧
  interface SupplyDraft {
    patientSupplies: Record<string, SupplyItem[]>;
    commonSupplies: SupplyItem[];
    // 📦 「作成する」で新規にいちから始めた下書きかどうか。trueの間は、まだ触れていない入居者の
    //    一覧を実データ（p.supplies）にフォールバックして映さない（＝保存済みの氏名・物品を表示しない）。
    //    そのため下書きに無い入居者は空欄として扱う。保存時は元々「下書きに無い入居者は変更なし扱いで
    //    実データに触れない」ため、この状態で保存しても他の入居者の保存済みデータは消えない
    startedBlank?: boolean;
  }
  const [supplyDraft, setSupplyDraft] = useState<SupplyDraft | null>(null);
  // 📦 物品管理の画面を開いた時、下書きがまだ無ければ（＝これから編集を始める時）、今の保存済みデータから作る
  React.useEffect(() => {
    if (currentView !== 'supply') return;
    if (supplyDraft !== null) return;
    setSupplyDraft({
      patientSupplies: Object.fromEntries(patients.map(p => [p.id, p.supplies])),
      commonSupplies,
    });
  }, [currentView, supplyDraft, patients, commonSupplies]);
  // 📦 下書きの中の1件の物品一覧（共通物品か、ある患者の一覧か）を書き換える共通ヘルパー
  const updateSupplyDraftList = (patientId: string, updater: (list: SupplyItem[]) => SupplyItem[]) => {
    setSupplyDraft(prev => {
      if (!prev) return prev;
      if (patientId === COMMON_SUPPLY_ID) {
        return { ...prev, commonSupplies: updater(prev.commonSupplies) };
      }
      const current = prev.patientSupplies[patientId] ?? [];
      return { ...prev, patientSupplies: { ...prev.patientSupplies, [patientId]: updater(current) } };
    });
  };
  // 💾 物品管理の「保存」ボタン：下書きの内容を、保存済みの実データ（patients・commonSupplies）へまとめて反映する。
  // 変更が無かった患者は書き換えない（touchLastEditedを不要に呼ばないため、下書き作成時と同じ配列参照かどうかで判定）
  const handleSaveSupplyDraft = () => {
    if (!supplyDraft) return;
    // 📜 定期履歴から「追加修正」を選んで過去の月（今日の実月とは別の月）を編集している場合は、
    //    現在進行中の実データ（patients・commonSupplies）には反映せず、その月の定期履歴だけを
    //    上書きする（過去の記録を直接書き換えるだけにするため）。判定は必ず「今日の実月」で行い、
    //    古いテストなどでずれた可能性のあるsupplyLiveMonthには頼らない
    const isEditingPastMonth = !!continuingSupplyMonthlyArchiveMonth && continuingSupplyMonthlyArchiveMonth !== getTodayISO().slice(0, 7);
    const nextPatients = patients.map(p => {
      const nextSupplies = supplyDraft.patientSupplies[p.id];
      if (!nextSupplies || nextSupplies === p.supplies) return p;
      return touchLastEdited({ ...p, supplies: nextSupplies });
    });
    const nextCommonSupplies = supplyDraft.commonSupplies;
    // 📦 「作成する」でいちから始めた（startedBlank）下書きで、共通物品に一度も触れていない場合は
    //    空欄のまま。ここでそのまま保存すると保存済みの共通物品が消えてしまうため、その時だけは
    //    共通物品を実データへ反映しない（入居者ごとの下書きは、触れていない人は元々スキップされる）
    const shouldSkipCommonSupplies = !!supplyDraft.startedBlank && nextCommonSupplies.length === 0;
    if (!isEditingPastMonth) {
      setPatients(nextPatients);
      if (!shouldSkipCommonSupplies) {
        setCommonSupplies(nextCommonSupplies);
      }
    }
    // 📦 定期作成・臨時作成の保存ボタンから保存した内容は、それぞれの履歴にも残す。
    //    定期履歴は月ごと（月に1回だけ・修正のたびに同じ月を上書き）、臨時履歴は実際に保存した日ごとに残す
    if (isSupplyNewCreationOpen) {
      const hasNamedSupply = (list: SupplyItem[]) => list.some(s => s.name.trim() !== '');
      const snapshot: SupplyMonthlySnapshot = {
        patients: nextPatients
          .filter(p => hasNamedSupply(p.supplies))
          .map(p => ({ patientId: p.id, room: p.room, name: p.name, supplies: p.supplies })),
        // 📦 共通物品への反映を見送った場合（shouldSkipCommonSupplies）は、履歴にも実際に生きている
        //    共通物品（commonSupplies）をそのまま記録する（空の下書きをそのまま記録しないように）
        commonSupplies: (shouldSkipCommonSupplies ? commonSupplies : nextCommonSupplies).filter(s => s.name.trim() !== ''),
      };
      if (supplyNewCreationKind === '定数') {
        // 📅 定期履歴も臨時履歴と同じく、🗓️「作成日」で選んだ月をそのまま使う（billingMonthは使わない）
        const month = continuingSupplyMonthlyArchiveMonth || (supplyItemCreationDate || getTodayISO()).slice(0, 7);
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const timeLabel = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        // 🕒 臨時履歴と同様に、作成日時（savedAt）は最初に保存された時のまま変えず、追加修正で
        //    上書き保存した時だけ更新した日付・時刻（updatedAt）を記録する
        setSupplyMonthlyArchive(prev => {
          const existing = prev[month];
          const nextEntry: SupplyMonthlySnapshot = existing
            ? { ...snapshot, savedAt: existing.savedAt, updatedAt: formatNowTimestamp() }
            : { ...snapshot, savedAt: timeLabel };
          return { ...prev, [month]: nextEntry };
        });
        setContinuingSupplyMonthlyArchiveMonth(null);
        if (isEditingPastMonth) {
          // 📜 過去の月の記録を保存しただけなので、画面は今の実データ（今月分）へ戻す
          setSupplyDraft(null);
          setIsSupplyNewCreationOpen(false);
          setBillingMonth(getTodayISO().slice(0, 7));
        } else {
          // 📜 今画面（実データ）に表示されている内容が、この月の記録と対応していることを記録しておく。
          //    後でこの月の履歴が削除された時、実データ側の物品も一緒に消せるようにするため
          setDisplayedSupplyMonthlyArchiveMonth(month);
        }
      } else {
        const now = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        // 📅 臨時履歴の日付は、実際に保存した日ではなく、利用者が🗓️「作成日」で選んだ日をそのまま使う
        //    （作成日は保存しても崩さず、選んだ通りに履歴へ反映する）。同じ作成日を選んだまま日をまたいで
        //    複数回保存しても記録が重ならないよう、時刻（秒まで）を組み合わせて一意のキーにする。
        // 🕒 臨時履歴から「追加修正」を選んで続きを編集している場合は、新しい記録を作らずそのキーへ上書きする
        const creationDatePart = supplyItemCreationDate || getTodayISO();
        const entryKey = continuingSupplyTemporaryArchiveKey
          || `${creationDatePart}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        const timeLabel = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        setSupplyTemporaryArchive(prev => {
          // 🕒 作成日時（savedAt）は最初に保存された時のまま変えない。追加修正で上書き保存した時だけ、
          //    更新した日付・時刻（updatedAt）を記録する（時系列の並び順はあくまでentryKey＝作成日時で決まる）
          const existing = prev[entryKey];
          const nextEntry: SupplyMonthlySnapshot = existing
            ? { ...snapshot, savedAt: existing.savedAt, updatedAt: formatNowTimestamp() }
            : { ...snapshot, savedAt: timeLabel };
          return { ...prev, [entryKey]: nextEntry };
        });
        setContinuingSupplyTemporaryArchiveKey(null);
        // 📜 今画面に表示されている内容が、この記録（entryKey）と対応していることを記録しておく。
        //    後でこの記録が履歴から削除された時、画面側もそれに合わせて消せるようにするため
        setDisplayedSupplyTemporaryArchiveKey(entryKey);
        // 📦 臨時作成エリアの左下に表示する「最終保存」日時・実施者を更新する
        const savedAt = formatNowTimestamp();
        const savedBy = loggedInUser || '不明なユーザー';
        setSupplyTemporaryLastSavedAt(savedAt);
        setSupplyTemporaryLastSavedBy(savedBy);
        if (typeof window !== 'undefined') {
          localStorage.setItem('oncall_supply_temporary_last_saved_at', savedAt);
          localStorage.setItem('oncall_supply_temporary_last_saved_by', savedBy);
        }
      }
    }
    alert('💾 保存しました');
  };

  // 🔒 ページ再読み込み後に、保存済みデータが正しく1回だけ復元されたかを管理するフラグ
  const [isPatientsRestored, setIsPatientsRestored] = useState(false);

  // 💾 マウント後（クライアント側のみ）に、localStorageへ保存されている入居者データを復元する
  // ※これがないと、ページを再読み込みするたびに④日/期間などの変更内容がすべて消えてしまう
  // ⚠️ キー名に「v2」を付けているのは、開発中に保存された古い形式のデータ（新しく追加した項目を
  // 持っていないデータ）を誤って読み込んでエラーを起こさないようにするためです。
  React.useEffect(() => {
    if (typeof window === 'undefined') {
      setIsPatientsRestored(true);
      return;
    }
    try {
      const saved = localStorage.getItem('oncall_patients_v3');
      if (saved) {
        const parsed = JSON.parse(saved) as Patient[];
        // 🔒 データの形が壊れていないか（最低限のプロパティが揃っているか）を確認してから復元する
        const isValid = Array.isArray(parsed) && parsed.length > 0 && parsed.every(p =>
          p && typeof p === 'object' && typeof p.id === 'string' && typeof p.room === 'string' &&
          typeof p.orderPeriods === 'object' && typeof p.orderCreatedBy === 'object' &&
          Array.isArray(p.emergencySummary?.contraindicatedMedications)
        );
        if (isValid) {
          // 🦠 感染症有無は、以前は1つの自由記述欄（infectionStatusText）だったが、禁忌薬と同じ1項目＝1欄の
          // リスト形式（infectionStatusItems）に変更した。古い形式で保存された既存データが消えてしまわないよう、
          // 読み込み時に自由記述を改行ごとに分割してリストへ変換する（すでに新形式なら何もしない）
          const migrated = parsed.map(p => {
            const rawSummary = p.emergencySummary as unknown as { infectionStatusText?: string; infectionStatusItems?: InfectionStatusItem[] };
            const nextP = Array.isArray(rawSummary.infectionStatusItems) ? p : (() => {
              const oldText = typeof rawSummary.infectionStatusText === 'string' ? rawSummary.infectionStatusText : '';
              const items: InfectionStatusItem[] = oldText.split(/\r?\n/).map(t => t.trim()).filter(Boolean).map((text, i) => ({ id: `is_${p.id}_${i}`, text }));
              return { ...p, emergencySummary: { ...p.emergencySummary, infectionStatusItems: items } };
            })();
            // 📦 物品管理：以前の保存形式（使用数used・単一の使用予定日）を新しい形へ変換する
            return { ...nextP, supplies: nextP.supplies.map(migrateSupplyItem) };
          });
          setPatients(migrated);
        } else if (saved) {
          console.warn('保存データの形式が古いため、初期データで開始します。');
          localStorage.removeItem('oncall_patients_v3');
        }
      }
    } catch (e) {
      console.error('入居者データの復元に失敗しました:', e);
    }
    setIsPatientsRestored(true);
  }, []);

  // 💾 patientsが変化するたびに、自動でlocalStorageへ保存する（復元が完了してから保存を始める）
  React.useEffect(() => {
    if (!isPatientsRestored) return;
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem('oncall_patients_v3', JSON.stringify(patients));
    } catch (e) {
      console.error('入居者データの保存に失敗しました:', e);
    }
  }, [patients, isPatientsRestored]);

  // 💾 共通物品が変化するたびに、自動でlocalStorageへ保存する（復元が完了してから保存を始める）
  React.useEffect(() => {
    if (!isPatientsRestored) return;
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem('oncall_common_supplies', JSON.stringify(commonSupplies));
    } catch (e) {
      console.error('共通物品の保存に失敗しました:', e);
    }
  }, [commonSupplies, isPatientsRestored]);

  // 💾 物品管理の月別履歴が変化するたびに、自動でlocalStorageへ保存する（復元が完了してから保存を始める）
  React.useEffect(() => {
    if (!isPatientsRestored) return;
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem('oncall_supply_monthly_archive', JSON.stringify(supplyMonthlyArchive));
    } catch (e) {
      console.error('物品管理の月別履歴の保存に失敗しました:', e);
    }
  }, [supplyMonthlyArchive, isPatientsRestored]);

  // 💾 物品管理の臨時履歴が変化するたびに、自動でlocalStorageへ保存する（復元が完了してから保存を始める）
  React.useEffect(() => {
    if (!isPatientsRestored) return;
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem('oncall_supply_temporary_archive', JSON.stringify(supplyTemporaryArchive));
    } catch (e) {
      console.error('物品管理の臨時履歴の保存に失敗しました:', e);
    }
  }, [supplyTemporaryArchive, isPatientsRestored]);

  // 🧹 以前は、履歴（臨時履歴）だけ×で削除しても、実データ側の臨時物品がそのまま画面に残ってしまう
  //    不具合があった。ログイン時に一度だけ、臨時履歴に記録が1件も残っていない「孤立した」臨時物品を
  //    実データ（patients・commonSupplies）から取り除き、履歴と画面の内容を揃える
  const hasReconciledOrphanTemporarySupplies = React.useRef(false);
  React.useEffect(() => {
    if (!isPatientsRestored) return;
    if (hasReconciledOrphanTemporarySupplies.current) return;
    hasReconciledOrphanTemporarySupplies.current = true;
    const archivedTemporaryIds = new Set<string>();
    Object.values(supplyTemporaryArchive).forEach(entry => {
      entry.commonSupplies.forEach(s => archivedTemporaryIds.add(s.id));
      entry.patients.forEach(p => p.supplies.forEach(s => archivedTemporaryIds.add(s.id)));
    });
    const isOrphanTemporary = (s: SupplyItem) => (s.kind || '定数') === '臨時' && !archivedTemporaryIds.has(s.id);
    setCommonSupplies(prev => prev.some(isOrphanTemporary) ? prev.filter(s => !isOrphanTemporary(s)) : prev);
    setPatients(prev => prev.map(p => {
      if (!p.supplies.some(isOrphanTemporary)) return p;
      return touchLastEdited({ ...p, supplies: p.supplies.filter(s => !isOrphanTemporary(s)) });
    }));
  }, [isPatientsRestored, supplyTemporaryArchive]);

  // 💾 物品管理の「定期作成／臨時作成を開いているかどうか・どちらの区分か」が変わるたびに保存する。
  //    次にこの画面に来た時（ログアウト後の再ログインも含む）、何月分・定期か臨時かの表記がそのまま残るように
  React.useEffect(() => {
    if (!isPatientsRestored) return;
    if (typeof window === 'undefined') return;
    localStorage.setItem('oncall_supply_new_creation_open', isSupplyNewCreationOpen ? 'true' : 'false');
    localStorage.setItem('oncall_supply_new_creation_kind', supplyNewCreationKind);
  }, [isSupplyNewCreationOpen, supplyNewCreationKind, isPatientsRestored]);

  // 🗓️ 物品管理のログイン時の自動処理：定数の月初めリセット。今月まだリセットしていなければ、
  // 定数（allocated）を基準値（baseAllocated）へ戻す。定数は「毎月必要な数」であり、使用予定日の
  // レ点では変化しない（レ点で変化するのは在庫のみ。手動でチェックした時だけ在庫を1減らす）。
  // 継続的に時計を監視するのではなく、ログイン時（マウント時）に1回だけ判定する
  // （「右上のカレンダーの暦はログインした日とする」「定数は月初め1日から始まり一か月ごとに計算する」との指定のため）
  const reconcileSupplyOnLogin = (supplies: SupplyItem[]): { next: SupplyItem[]; changed: boolean } => {
    const currentMonth = getTodayISO().slice(0, 7);
    let changed = false;
    const next = supplies.map(s => {
      // 🔧 「▶」で今日の実月より先（未来）の月まですでに繰り上げ済みの物品は、ここで今月分に
      //    巻き戻さない（過去にlastResetMonth !== currentMonthだけで判定していたため、翌月・翌々月へ
      //    進めておいたはずの定数・カレンダーが、ログインし直すたびに今月分へ戻ってしまう不具合があった）。
      //    本当に古い（今月より前の）月のままの時だけ、今月分へ追いつかせる
      if (s.lastResetMonth >= currentMonth) return s;
      changed = true;
      // 📅 曜日×間隔（2週間おき／30日おき）のパターンがある物品は、今月分の使用予定日を作り直し、
      //    その回数（例：3回／2回）に定数・基準定数・在庫を合わせる（カレンダーの月と定数がずれないように）
      if (s.recurringPattern) {
        const scheduledUseDates = generateRecurringWeekdayDates(currentMonth, s.recurringPattern.weekday, s.recurringPattern.intervalDays).map(date => ({ date, applied: false }));
        const count = scheduledUseDates.length;
        return { ...s, allocated: count, baseAllocated: count, stock: count, lastResetMonth: currentMonth, scheduledUseDates };
      }
      return { ...s, allocated: s.baseAllocated, lastResetMonth: currentMonth };
    });
    return { next, changed };
  };
  React.useEffect(() => {
    if (!isPatientsRestored) return;
    setPatients(prev => {
      let anyChanged = false;
      const next = prev.map(p => {
        const { next: nextSupplies, changed } = reconcileSupplyOnLogin(p.supplies);
        if (!changed) return p;
        anyChanged = true;
        return touchLastEdited({ ...p, supplies: nextSupplies });
      });
      return anyChanged ? next : prev;
    });
    setCommonSupplies(prev => {
      const { next, changed } = reconcileSupplyOnLogin(prev);
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPatientsRestored]);

  // ↩️ 「戻る」＝直前の編集を1件だけ取り消すUndo。patients（バイタル・医師指示・観察要点・頓用薬の保存済み内容など、
  // このアプリの入居者データのほぼすべて）が変化するたびに、変化前の状態を履歴として積んでおく
  // （業務連絡シートの下書きなど、patients以外の別ステートで管理している内容はUndoの対象外）
  const patientsHistoryRef = React.useRef<Patient[][]>([]);
  const prevPatientsRef = React.useRef<Patient[] | null>(null);
  const isUndoingRef = React.useRef(false);
  React.useEffect(() => {
    if (!isPatientsRestored) return;
    if (isUndoingRef.current) {
      // 🔒 Undoによる書き戻し自体は、新たな履歴として積まない
      isUndoingRef.current = false;
      prevPatientsRef.current = patients;
      return;
    }
    if (prevPatientsRef.current !== null && prevPatientsRef.current !== patients) {
      patientsHistoryRef.current.push(prevPatientsRef.current);
      if (patientsHistoryRef.current.length > 20) patientsHistoryRef.current.shift();
    }
    prevPatientsRef.current = patients;
  }, [patients, isPatientsRestored]);

  // ↩️ 「戻る」ボタン：直前の1件を取り消して、変化前の状態に戻す
  const handleUndoLastPatientsChange = () => {
    const history = patientsHistoryRef.current;
    if (history.length === 0) {
      alert('取り消せる操作がありません。');
      return;
    }
    const previous = history.pop()!;
    isUndoingRef.current = true;
    setPatients(previous);
  };

  // 💾 業務連絡シートを保存する（localStorageに残るので、再ログイン・リロードしても消えない）。
  //    同時に、今の「作成日」をキーとして履歴（handoverNoteArchive）にも記録し、
  //    左上の「履歴▼」から過去の日の内容を見返せるようにする
  const handleSaveHandoverNote = () => {
    const savedAt = formatNowTimestamp();
    const savedBy = loggedInUser || '不明なユーザー';
    const archiveDate = handoverCreationDate || getTodayISO();
    // 📅 未来日（ログインした日の翌日）向けに保存した内容は、その日になってログインし直すまでは
    //    「未確定」扱いにし、文字を薄いグレーで表示する
    const isFuture = archiveDate > getTodayISO();
    setSavedHandoverNote(handoverNote);
    setHandoverNoteSavedBy(savedBy);
    setHandoverNoteSavedAt(savedAt);
    setSavedHandoverNoteDate(archiveDate);
    setHandoverNoteConfirmed(!isFuture);
    setHandoverNoteArchive(prev => {
      const next = { ...prev, [archiveDate]: { text: handoverNote, savedAt, savedBy } };
      if (typeof window !== 'undefined') localStorage.setItem('oncall_handover_note_archive', JSON.stringify(next));
      return next;
    });
    if (typeof window !== 'undefined') {
      localStorage.setItem('oncall_handover_note', handoverNote);
      localStorage.setItem('oncall_handover_note_saved_by', savedBy);
      localStorage.setItem('oncall_handover_note_saved_at', savedAt);
      localStorage.setItem('oncall_handover_note_date', archiveDate);
      localStorage.setItem('oncall_handover_note_confirmed', isFuture ? 'false' : 'true');
    }
  };

  // ✅ 未来日向けに保存した内容を「確定」する（グレーの文字が黒字になる）
  const handleConfirmHandoverNote = () => {
    setHandoverNoteConfirmed(true);
    setIsHandoverConfirmPromptOpen(false);
    if (typeof window !== 'undefined') localStorage.setItem('oncall_handover_note_confirmed', 'true');
  };
  // 🗑️ 未来日向けに保存した内容を「確定しない」＝そのまま削除する
  const handleRejectHandoverNote = () => {
    setHandoverNote('');
    setSavedHandoverNote('');
    setHandoverNoteConfirmed(true);
    setIsHandoverConfirmPromptOpen(false);
    setHandoverNoteArchive(prev => {
      const next = { ...prev };
      if (savedHandoverNoteDate) delete next[savedHandoverNoteDate];
      if (typeof window !== 'undefined') localStorage.setItem('oncall_handover_note_archive', JSON.stringify(next));
      return next;
    });
    if (typeof window !== 'undefined') {
      localStorage.setItem('oncall_handover_note', '');
      localStorage.setItem('oncall_handover_note_confirmed', 'true');
    }
  };

  // 📜 操作履歴（誤操作の確認用）
  const [actionLog, setActionLog] = useState<ActionLogEntry[]>([]);

  // 🚨 緊急時対応サマリーシート：部屋をダブルクリックした時に開く詳細モーダル
  const [emergencyModalPatientId, setEmergencyModalPatientId] = useState<string | null>(null);

  // 🔒 部屋図の「意思決定・緊急時対応」レ点：いずれか1つをクリックすると、その入居者1人分の項目一覧を開く
  // （mapCheckboxEditorPatientId）。下書き（mapCheckboxDraft）は自由に触れて、保存時に1回だけ管理者パスワードを確認する
  const [mapCheckboxEditorPatientId, setMapCheckboxEditorPatientId] = useState<string | null>(null);
  const [mapCheckboxDraft, setMapCheckboxDraft] = useState<Record<MapCheckboxFieldKey, boolean>>({} as Record<MapCheckboxFieldKey, boolean>);

  // 🏠 空室クリック時に開く新規入居者登録モーダル。氏名欄をここでIME入力してもらうことで、
  //    緊急時対応サマリーシートの氏名編集と同じ仕組みでふりがなも同時に自動取得できるようにする
  //    （window.prompt()での入力だとIMEの変換過程を拾えず、ふりがなが空のままになってしまうため）
  const [newPatientRoom, setNewPatientRoom] = useState<string | null>(null);
  const [newPatientDraft, setNewPatientDraft] = useState<{ name: string; nameKana: string; gender: 'male' | 'female' }>({ name: '', nameKana: '', gender: 'male' });

  // 📦 物品管理：氏名欄をダブルクリックすると、部屋図の入居者のうちまだ物品名が1件も無い人だけを
  //    一覧表示して選ぶピッカーを開く（物品を実際に使う人だけを一覧に載せるため。候補を選んだら
  //    最初の物品名を入力してもらい、実際に保存されて初めて一覧に名前が現れる）
  const [isSupplyPatientPickerOpen, setIsSupplyPatientPickerOpen] = useState(false);
  // supplyId が無ければ新規の物品を追加する下書き、あればその物品の書き換え（名前の間違い修正・定数変更）の下書き
  // 🔒 patientId が COMMON_SUPPLY_ID の場合は、特定の入居者ではなく「共通物品」（施設共通・部屋番号を持たない物品）の下書き
  const [supplyNewItemDraft, setSupplyNewItemDraft] = useState<{ patientId: string; name: string; allocated: string; unit: '個' | '箱'; kind: '定数' | '臨時'; supplyId?: string } | null>(null);
  // 📦 物品名下書きフォームの「定数／臨時」選択ドロップダウンの開閉
  const [isSupplyKindPickerOpen, setIsSupplyKindPickerOpen] = useState(false);
  // 📦 物品名欄をクリックすると開く、定型カタログ（SUPPLY_CATALOG）のブラウズ状態。
  //    falseなら非表示、nullなら物品タイトル一覧を表示、文字列ならそのタイトル内の物品名一覧を表示する
  const [supplyCatalogView, setSupplyCatalogView] = useState<string | null | false>(false);
  // 📦 物品名の右の「＋」を押して、物品名の下にメモ欄を開いた物品のidの集合（メモに文字がすでにあれば自動的に開く）
  const [expandedSupplyMemoIds, setExpandedSupplyMemoIds] = useState<Set<string>>(new Set());
  // 📦 「使用」の右の🗓️で開く、使用予定日を選ぶカレンダー。開いている物品（`${patientId}::${supplyId}`）と、
  //    カレンダーが現在表示している月（YYYY-MM）を持つ。日にちの選択に制限は無い
  const [openSupplyDateCalendarKey, setOpenSupplyDateCalendarKey] = useState<string | null>(null);
  const [supplyDateCalendarMonth, setSupplyDateCalendarMonth] = useState<string>('');
  // 🗓️ 使用予定日カレンダーで、まだ保存していない選択中の日にち（複数選べる。保存を押すまでは確定しない）
  const [supplyDateDraftSelection, setSupplyDateDraftSelection] = useState<string[]>([]);
  // 🗓️ 使用予定日カレンダー内の「月火水木金土日」＋「2週間おき」「30日おき」での一括選択に使う、選択中の曜日
  const [supplyRecurringWeekday, setSupplyRecurringWeekday] = useState<number | null>(null);
  // 🗓️ 直近で使った間隔（14＝2週間おき／30＝30日おき）。保存時にrecurringPatternとして物品に記録する
  const [supplyRecurringIntervalDays, setSupplyRecurringIntervalDays] = useState<number | null>(null);
  // 📦 定数はクリックしないと書き換えられない固定表示にする。編集中の物品（`${patientId}::${supplyId}`）と
  // 編集中の入力値を持つ（変更を確定すると「変更しますね」とお知らせしてから反映する）
  const [editingSupplyAllocatedKey, setEditingSupplyAllocatedKey] = useState<string | null>(null);
  const [editingSupplyAllocatedValue, setEditingSupplyAllocatedValue] = useState('');
  // 📦 定数を変更した時の「変更しますね」お知らせ。他の場所をクリックすれば（そのまま変更を受け入れて）閉じるが、
  // 「キャンセル」を押すとその場で元の数へ取り消せる。取り消すために、変更前の値も一緒に持っておく
  const [supplyChangeToast, setSupplyChangeToast] = useState<{ patientId: string; supplyId: string; previousValue: number; top: number; left: number } | null>(null);
  // ⚠️ 定数の数値入力からフォーカスが外れる（＝別の場所をクリックする）ことで初めてこのお知らせが開くため、
  // その「開くきっかけになったクリック」がそのままdocument側にも伝わり、開いた直後に自分自身を
  // 閉じてしまう（一瞬で消える）。そこで、開いた直後の1回目のクリックだけは無視するようにする
  const supplyToastJustOpenedRef = React.useRef(false);
  React.useEffect(() => {
    if (!supplyChangeToast) return;
    supplyToastJustOpenedRef.current = true;
    const handleOutsideClick = () => {
      if (supplyToastJustOpenedRef.current) {
        supplyToastJustOpenedRef.current = false;
        return;
      }
      setSupplyChangeToast(null);
    };
    document.addEventListener('click', handleOutsideClick);
    return () => {
      document.removeEventListener('click', handleOutsideClick);
    };
  }, [supplyChangeToast]);
  // ↩️ 「キャンセル」：定数の変更をその場で取り消し、変更前の数へ戻す
  const handleCancelSupplyAllocatedChange = () => {
    if (!supplyChangeToast) return;
    handleUpdateSupply(supplyChangeToast.patientId, supplyChangeToast.supplyId, 'allocated', supplyChangeToast.previousValue);
    setSupplyChangeToast(null);
  };

  // 📋 往診記録アーカイブ：日付をタップした時だけ、その日の全員分の記録を開く（アコーディオン）
  const [expandedVisitDates, setExpandedVisitDates] = useState<{ [date: string]: boolean }>({});
  const toggleVisitDateExpand = (date: string) => {
    setExpandedVisitDates(prev => ({ ...prev, [date]: !prev[date] }));
  };
  // 🗑️ 往診記録アーカイブの削除：誤操作防止のため管理者パスワードを必須にする（退去・往診サイクル開始と同様）
  const handleDeleteVisitArchiveGroup = (dateLabel: string, timestamp: number) => {
    const confirmDelete = window.confirm(`${dateLabel}の往診記録を削除します。よろしいですか？\n※この操作は取り消せません。`);
    if (!confirmDelete) return;

    const MASTER_PASSWORD = 'master999';
    const inputPassword = prompt('⚠️ 往診記録の削除には管理者パスワードが必要です。\nパスワードを入力してください：');
    if (inputPassword === null) return;
    if (inputPassword !== MASTER_PASSWORD) {
      alert('❌ パスワードが正しくありません。操作は取り消されました。');
      return;
    }

    setPatients(prev => prev.map(p => ({
      ...p,
      visitHistory: p.visitHistory.filter(v => v.timestamp !== timestamp),
    })));
  };
  // 📜 VS・医師連携画面の「履歴▼」：診療日の枠の下にたたんで置き、開いた時だけ往診記録アーカイブを表示する
  const [isDoctorVisitHistoryOpen, setIsDoctorVisitHistoryOpen] = useState(false);

  // ✏️ 往診記録アーカイブの追加修正：同日の記録は1件のみのため、間違いがあれば作り直すのではなく
  //    その場で編集して上書きできるようにする。編集中は下書き（archiveRecordDraft）だけを書き換え、
  //    保存を押した時点で該当する入居者のvisitHistoryの、その1件だけを差し替える
  const [editingArchiveRecordId, setEditingArchiveRecordId] = useState<string | null>(null);
  const [archiveRecordDraft, setArchiveRecordDraft] = useState<VisitRecord | null>(null);
  const handleStartEditArchiveRecord = (record: VisitRecord) => {
    setEditingArchiveRecordId(record.id);
    setArchiveRecordDraft(JSON.parse(JSON.stringify(record)) as VisitRecord);
  };
  const handleCancelEditArchiveRecord = () => {
    setEditingArchiveRecordId(null);
    setArchiveRecordDraft(null);
  };
  const handleSaveEditArchiveRecord = (patientId: string) => {
    if (!archiveRecordDraft) return;
    // 📜 編集の記録は上書きせず追記する：2回編集したら2回とも✏️編集ボタンのホバーで見えるようにする
    const draft: VisitRecord = {
      ...archiveRecordDraft,
      archiveEditHistory: [
        ...(archiveRecordDraft.archiveEditHistory || []),
        { editedBy: loggedInUser || '不明なユーザー', editedAt: formatNowTimestamp() },
      ],
    };
    setPatients(prev => prev.map(p => p.id !== patientId ? p : {
      ...p,
      visitHistory: p.visitHistory.map(v => v.id === draft.id ? draft : v),
    }));
    setEditingArchiveRecordId(null);
    setArchiveRecordDraft(null);
  };
  // ✏️ 指示内容の1行を編集（チェック・文言・期間）：行の削除や追加も、この下書き内だけで完結させる
  const handleArchiveDraftToggleOrderChecked = (idx: number) => {
    setArchiveRecordDraft(prev => {
      if (!prev) return prev;
      const current = prev.orderStatus[idx] || { checked: false };
      return { ...prev, orderStatus: { ...prev.orderStatus, [idx]: { ...current, checked: !current.checked } } };
    });
  };
  const handleArchiveDraftChangeOrderLine = (idx: number, text: string) => {
    setArchiveRecordDraft(prev => {
      if (!prev) return prev;
      const lines = prev.doctorOrder.split('\n');
      lines[idx] = text;
      return { ...prev, doctorOrder: lines.join('\n') };
    });
  };
  const handleArchiveDraftChangePeriodText = (idx: number, text: string) => {
    setArchiveRecordDraft(prev => {
      if (!prev) return prev;
      const current = prev.orderPeriods[idx] || { startDate: '', durationDays: null };
      return { ...prev, orderPeriods: { ...prev.orderPeriods, [idx]: { ...current, manualText: text } } };
    });
  };
  const handleArchiveDraftDeleteOrderLine = (idx: number) => {
    setArchiveRecordDraft(prev => {
      if (!prev) return prev;
      const lines = prev.doctorOrder.split('\n');
      lines.splice(idx, 1);
      const reindex = <T,>(map: { [i: number]: T }): { [i: number]: T } => {
        const next: { [i: number]: T } = {};
        Object.keys(map).map(Number).filter(i => i !== idx).forEach(i => {
          next[i > idx ? i - 1 : i] = map[i];
        });
        return next;
      };
      return {
        ...prev,
        doctorOrder: lines.join('\n'),
        orderStatus: reindex(prev.orderStatus),
        orderCreatedBy: reindex(prev.orderCreatedBy),
        orderPeriods: reindex(prev.orderPeriods),
      };
    });
  };
  const handleArchiveDraftAddOrderLine = (text: string) => {
    if (text.trim() === '') return;
    setArchiveRecordDraft(prev => {
      if (!prev) return prev;
      const lines = prev.doctorOrder.split('\n').filter(l => l.trim() !== '');
      lines.push(text);
      return { ...prev, doctorOrder: lines.join('\n') };
    });
  };
  const [archiveManualOrderInput, setArchiveManualOrderInput] = useState('');

  // 🗓️ 往診日（次回往診サイクル開始で自動的に2週間後の日付が入る。手動でも書き換え可能）
  // 「決定」ボタンを押すまでは下書き（isVisitDateEditorOpen中の一時編集）として扱い、保存するとセッションに残る
  const [nextVisitDate, setNextVisitDate] = useState<string>('');
  const [isVisitDateEditorOpen, setIsVisitDateEditorOpen] = useState(false);
  const [visitDateDraft, setVisitDateDraft] = useState<string>('');
  // 🗓️ カレンダーが現在表示している月（YYYY-MM）。選択中の日付とは別に、月だけ移動できるようにする
  const [visitDateCalendarMonth, setVisitDateCalendarMonth] = useState<string>('');

  const openVisitDateEditor = () => {
    const initial = nextVisitDate || formatISOToJapaneseDate(getTodayISO());
    setVisitDateDraft(initial);
    const initialIso = parseJapaneseDateToISO(initial) || getTodayISO();
    setVisitDateCalendarMonth(initialIso.slice(0, 7));
    setIsVisitDateEditorOpen(true);
  };

  // 📌 往診日の下書きをボタンで1日ずつ進める・戻す（<input type="date">はブラウザ環境で反応しないことがあるため使わない）
  const shiftVisitDateDraft = (deltaDays: number) => {
    const currentIso = parseJapaneseDateToISO(visitDateDraft) || getTodayISO();
    const d = new Date(currentIso + 'T00:00:00');
    d.setDate(d.getDate() + deltaDays);
    const nextIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    setVisitDateDraft(formatISOToJapaneseDate(nextIso));
    setVisitDateCalendarMonth(nextIso.slice(0, 7));
  };

  // 🗓️ カレンダーの表示月を前後に1ヶ月ずつ移動する
  const shiftVisitDateCalendarMonth = (deltaMonths: number) => {
    setVisitDateCalendarMonth(prev => {
      const [y, m] = (prev || getTodayISO().slice(0, 7)).split('-').map(Number);
      const d = new Date(y, m - 1 + deltaMonths, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });
  };

  // 🗓️ カレンダーの表示月の日付セルを1件ずつ返す（月の1日が何曜日から始まるかに合わせて先頭を空セルで埋める）
  const getCalendarMonthCells = (yyyymm: string): (string | null)[] => {
    const [y, m] = yyyymm.split('-').map(Number);
    if (!y || !m) return [];
    const startWeekday = new Date(y, m - 1, 1).getDay();
    const daysInMonth = new Date(y, m, 0).getDate();
    const cells: (string | null)[] = Array.from({ length: startWeekday }, () => null);
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
    return cells;
  };

  // 💾 往診日を決定・保存する（セッションに残るのでリロードしても消えない）
  const handleSaveVisitDate = () => {
    setNextVisitDate(visitDateDraft);
    if (typeof window !== 'undefined') {
      localStorage.setItem('oncall_next_visit_date', visitDateDraft);
    }
    setIsVisitDateEditorOpen(false);
  };

  // 🌐 複数端末（職場PC・外出先のスマホ等）で同じ内容を見られるよう、入居者データ・業務連絡シート・
  // 往診日（＝オンコール引き継ぎの本体データ）はlocalStorageに加えてサーバー（DB）にも保存・同期する。
  // 「最後に保存した内容が正」という単純な方式で、細かい同時編集の競合解決はしない。
  // ログインID一覧・各種入力履歴（クリニック名・内服薬など）は端末ごとの操作抑止・補助入力に過ぎないため
  // 同期対象に含めない（従来通りlocalStorageのみ）。
  const [isServerStateLoaded, setIsServerStateLoaded] = useState(false);
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    fetch('/api/state')
      .then(res => (res.ok ? res.json() : null))
      .then((data: SharedAppState | null) => {
        if (data) {
          if (Array.isArray(data.patients)) setPatients(data.patients);
          if (typeof data.nextVisitDate === 'string') setNextVisitDate(data.nextVisitDate);
          if (typeof data.handoverNote === 'string') setHandoverNote(data.handoverNote);
          if (typeof data.savedHandoverNote === 'string') setSavedHandoverNote(data.savedHandoverNote);
          if (typeof data.handoverNoteSavedBy === 'string') setHandoverNoteSavedBy(data.handoverNoteSavedBy);
          if (typeof data.handoverNoteSavedAt === 'string') setHandoverNoteSavedAt(data.handoverNoteSavedAt);
          if (typeof data.savedHandoverNoteDate === 'string') setSavedHandoverNoteDate(data.savedHandoverNoteDate);
          if (typeof data.handoverNoteConfirmed === 'boolean') setHandoverNoteConfirmed(data.handoverNoteConfirmed);
          if (data.handoverNoteArchive && typeof data.handoverNoteArchive === 'object') setHandoverNoteArchive(data.handoverNoteArchive);
        }
      })
      .catch(e => console.error('サーバーからのデータ取得に失敗しました:', e))
      .finally(() => setIsServerStateLoaded(true));
  }, []);
  React.useEffect(() => {
    if (!isServerStateLoaded) return;
    if (typeof window === 'undefined') return;
    const timer = setTimeout(() => {
      const payload: SharedAppState = {
        patients, nextVisitDate, handoverNote, savedHandoverNote, handoverNoteSavedBy,
        handoverNoteSavedAt, savedHandoverNoteDate, handoverNoteConfirmed, handoverNoteArchive,
      };
      fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(e => console.error('サーバーへの保存に失敗しました:', e));
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patients, nextVisitDate, handoverNote, savedHandoverNote, handoverNoteSavedBy, handoverNoteSavedAt, savedHandoverNoteDate, handoverNoteConfirmed, handoverNoteArchive, isServerStateLoaded]);

  // 🚨 保存ボタンを押すまでは実データに反映しない「下書き」状態
  const [summaryDraft, setSummaryDraft] = useState<{ patientId: string; name: string; age: number | null; gender: 'male' | 'female'; summary: EmergencySummary } | null>(null);
  // ⌨️ 生年月日欄に入力中の数字（西暦なら8桁、和暦なら6桁で確定するとdraft.summary.birthDateへ反映される）
  const [birthDateRawInput, setBirthDateRawInput] = useState('');
  // 🗓️ 生年月日欄で選択中の暦（西暦／明治／大正／昭和／平成／令和）
  const [birthDateEraMode, setBirthDateEraMode] = useState<BirthDateEraMode>('西暦');
  // 🗓️ 生年月日の入力欄（暦切り替えボタン＋数字入力）を表示中かどうか。入力が完了すると自動的に畳んで、和暦表記の確定表示だけにする
  const [isBirthDateEditing, setIsBirthDateEditing] = useState(true);
  // 🏠 キーパーソンの郵便番号→住所検索の状態（キーパーソンIDごと）
  const [postalLookupStatus, setPostalLookupStatus] = useState<{ [keyPersonId: string]: 'loading' | 'error' | undefined }>({});

  // 🔢 電卓（テンキー）ポップアップ用のステート
  const [keypadConfig, setKeypadConfig] = useState<{
    isOpen: boolean;
    patientId: string;
    patientName: string;
    field: 'kt' | 'bp' | 'spo2' | 'p';
    label: string;
    value: string;
  }>({
    isOpen: false,
    patientId: '',
    patientName: '',
    field: 'kt',
    label: '',
    value: ''
  });

  // 🔒 ログイン認証処理：スタッフ管理画面で追加・削除されたID・パスワードの一覧（staffAccounts）と照合する
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const match = staffAccounts.find(acc => acc.id === loginId && acc.password === password);

    if (match) {
      setIsAuthenticated(true);
      setLoginError('');
      setLoggedInUser(match.id);
      sessionStorage.setItem('oncall_auth', 'true');
      sessionStorage.setItem('oncall_user', match.id);
    } else {
      setLoginError('IDまたはパスワードが正しくありません。');
    }
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    setLoginId('');
    setPassword('');
    setLoggedInUser('');
    sessionStorage.removeItem('oncall_auth');
    sessionStorage.removeItem('oncall_user');
  };

  const generateRoomNumbers = () => {
    const rooms = [];
    for (let i = 101; i <= 310; i++) {
      const s = i.toString();
      if (!s.includes('4') && !s.includes('9')) {
        const num = parseInt(s);
        if ((num >= 101 && num <= 110) || (num >= 201 && num <= 220) || (num >= 301 && num <= 310)) {
          rooms.push(s);
        }
      }
    }
    return rooms;
  };

  // 🏠 各フロアに表示する部屋番号一覧
  // 1階は111〜114を追加表示するため、明示的な配列で管理しています
  // （114は「4」を含みますが、ご指定どおり表示対象に含めています）
  const FLOOR_ROOM_LISTS: { label: string; rooms: string[] }[] = [
    { label: '1階', rooms: ['101', '102', '103', '105', '106', '107', '108', '110', '111', '112', '113', '114'] },
    { label: '2階', rooms: generateRoomNumbers().filter(r => parseInt(r) >= 201 && parseInt(r) <= 220) },
    { label: '3階', rooms: generateRoomNumbers().filter(r => parseInt(r) >= 301 && parseInt(r) <= 310) },
  ];

  const handleUpdate = (id: string, key: keyof Patient, value: any) => {
    setPatients(prev => prev.map(p => p.id === id ? { ...p, [key]: value, lastEditedBy: loggedInUser || '不明なユーザー', lastEditedAt: formatNowTimestamp() } : p));
  };

  // 🕒 患者データを直接編集した時に「最終更新者・更新日」を記録する共通ヘルパー（handleUpdateを使わない各種操作から呼ぶ）
  const touchLastEdited = (p: Patient): Patient => ({
    ...p,
    lastEditedBy: loggedInUser || '不明なユーザー',
    lastEditedAt: formatNowTimestamp(),
  });

  // 🕒 最終更新者・更新日を、カーソルを合わせると表示するホバーアイコン（各画面で共通利用）
  const LastEditedHint = ({ p }: { p: Patient }) => {
    if (!p.lastEditedBy) return null;
    return (
      <span className="relative group/lastedit inline-flex items-center ml-1 no-print">
        <span className="text-[10px] text-slate-300 hover:text-slate-500 cursor-default">🕒</span>
        <span className="absolute left-0 top-full mt-1 hidden group-hover/lastedit:block bg-slate-800 text-white text-[9px] px-2 py-1 rounded whitespace-nowrap z-30 shadow-lg">
          👤 {p.lastEditedBy}　📅 {p.lastEditedAt}
        </span>
      </span>
    );
  };

  // ✏️ 往診記録アーカイブの編集ボタン：未編集は赤、編集済みは緑。編集履歴（誰が・いつ）は常時表示せず、
  //    カーソルを合わせた時だけ吹き出しで見える。この吹き出しは「履歴▼」のアコーディオン（overflow-hidden）や
  //    表の横スクロール枠（overflow-x-auto）の中にあるため、普通にabsolute配置すると枠の外にはみ出す部分が
  //    切り取られて見えなくなってしまう。そのため、position: fixedでdocument.bodyへポータル表示し、
  //    枠の影響を受けずに必ず見えるようにする
  const ArchiveEditBadge = ({ record, onClick }: { record: VisitRecord; onClick: () => void }) => {
    const btnRef = useRef<HTMLButtonElement>(null);
    const [hoverPos, setHoverPos] = useState<{ top: number; right: number } | null>(null);
    const history = record.archiveEditHistory || [];
    const hasHistory = history.length > 0;
    const showTooltip = () => {
      if (!hasHistory || !btnRef.current) return;
      const rect = btnRef.current.getBoundingClientRect();
      setHoverPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    };
    const hideTooltip = () => setHoverPos(null);
    return (
      <>
        <button
          ref={btnRef}
          type="button"
          onClick={onClick}
          onMouseEnter={showTooltip}
          onMouseLeave={hideTooltip}
          className={`no-print shrink-0 text-[10px] font-bold border rounded-lg px-1.5 py-0.5 ${
            hasHistory
              ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border-emerald-200'
              : 'text-rose-600 bg-rose-50 hover:bg-rose-100 border-rose-200'
          }`}
        >
          ✏️ 編集
        </button>
        {hoverPos && hasHistory && typeof document !== 'undefined' && createPortal(
          <div
            className="no-print fixed bg-slate-800 text-white text-[9px] px-2 py-1.5 rounded whitespace-nowrap shadow-lg space-y-0.5"
            style={{ top: hoverPos.top, right: hoverPos.right, zIndex: 9999 }}
          >
            {history.map((h, i) => (
              <div key={i}>👤 {h.editedBy}　📅 {h.editedAt}</div>
            ))}
          </div>,
          document.body
        )}
      </>
    );
  };

  // 📜 操作履歴に1件記録する（チェック・削除・追加・退去など、誤操作が起きやすい操作を対象とする）
  const logAction = (room: string, patientName: string, action: string, detail: string) => {
    const now = new Date();
    const timestamp = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    setActionLog(prev => [
      ...prev,
      {
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        timestamp,
        room,
        patientName,
        action,
        detail,
        user: loggedInUser || '不明なユーザー',
      },
    ]);
  };

  // 🏠 空室クリック時：新規入居者登録モーダルを開く（氏名・ふりがな・性別はモーダル側で入力してもらう）
  const handleAssignRoom = (room: string) => {
    setNewPatientDraft({ name: '', nameKana: '', gender: 'male' });
    setNewPatientRoom(room);
  };

  const handleCancelNewPatient = () => {
    setNewPatientRoom(null);
  };

  // 🏠 新規入居者登録モーダルの「登録する」：下書きの内容でその部屋番号に新規入居者を作成する
  const handleConfirmNewPatient = () => {
    if (!newPatientRoom) return;
    const trimmedName = newPatientDraft.name.trim();
    if (!trimmedName) {
      alert('お名前を入力してください。');
      return;
    }
    const displayName = trimmedName.endsWith('様') ? trimmedName : `${trimmedName} 様`;
    const room = newPatientRoom;
    const gender = newPatientDraft.gender;

    const newPatient: Patient = {
      id: `p_${Date.now()}`,
      name: displayName,
      room,
      gender,
      age: null,
      kt: '', bp: '', spo2: '', p: '',
      reportToDoctor: '',
      prevDoctorMemoHint: '',
      attachedFiles: [],
      doctorMemo: '',
      doctorOrder: '',
      orderStatus: {},
      orderCreatedBy: {},
      orderPeriods: {},
      dismissedSuggestions: [],
      isChangedInstruction: false,
      prnMedications: {},
      prnMedicationTextOverrides: {},
      prnMedicationTextMeta: {},
      prnManualEntries: [],
      prnSelectedOrder: [],
      observationList: '',
      observationStatus: {},
      dismissedObservations: [],
      lastEditedBy: loggedInUser || '不明なユーザー',
      lastEditedAt: formatNowTimestamp(),
      extractedDiseases: [],
      currentMedications: [],
      medicationHistory: [],
      hasBalloon: false,
      lastExchangeDate: '',
      nextExchangeDate: '',
      isExchangeChecked: false,
      supplies: [],
      dnr: false,
      gtube: false,
      cvport: false,
      facilityEndofLife: false,
      cpr: false,
      respirator: false,
      emergencyTransport: false,
      oxygen: false,
      ivDrip: false,
      emergencySummary: { ...createEmptyEmergencySummary(), nameKana: newPatientDraft.nameKana.trim() },
      visitHistory: [],
    };

    setPatients(prev => [...prev, newPatient]);
    setNewPatientRoom(null);
  };

  // 📦 「新規作成」「臨時作成」ボタン共通：月を進める操作と氏名・物品の選択エリアを開く。
  //    kindは、このあと氏名を選んだ時に作る物品の区分（定数／臨時）に使う
  const openSupplyNewCreation = (kind: '定数' | '臨時') => {
    // 📅 🗓️「作成日」カレンダーで選んだ月を基準にする（未設定なら今日の実月。supplyLiveMonthは
    //    古いテストなどでずれる可能性があるため使わない）
    const liveMonth = (supplyItemCreationDate || getTodayISO()).slice(0, 7);
    // 📦 臨時作成は、氏名・物品を新規にいちから選び直したいという要望のため、今画面に表示されている
    //    一覧（下書き）をいったん空にする。既存のデータは、すでにこれまでの保存で定期履歴・臨時履歴に
    //    残っているため、ここで空にしても記録自体は消えない。ただし「保存」を押すと、その空の状態＋
    //    新しく選んだ臨時の物品だけが実データ（patients・commonSupplies）へ反映され、それまで画面に出ていた
    //    定数物品を含む内容は実データからは消えるため、必ず確認する
    if (kind === '臨時') {
      // 📦 今「画面に実際に表示されている」一覧に、名前の付いた物品が1件も無い時は、
      //    そもそも空にする内容が無いため、確認なしでそのまま進める。startedBlankの下書き
      //    （「作成する」直後など、まだ何も選んでいない状態）はp.suppliesへフォールバックせず、
      //    画面と同じく空として扱う（実データがあっても、それが画面に映っていなければ確認しない）
      const hasNamedSupply = (list: SupplyItem[]) => list.some(s => s.name.trim() !== '');
      const currentCommonSupplies = supplyDraft ? supplyDraft.commonSupplies : commonSupplies;
      const hasAnyExistingSupplyItems = hasNamedSupply(currentCommonSupplies)
        || patients.some(p => hasNamedSupply(
          supplyDraft
            ? (supplyDraft.patientSupplies[p.id] ?? (supplyDraft.startedBlank ? [] : p.supplies))
            : p.supplies
        ));
      if (hasAnyExistingSupplyItems && !window.confirm('臨時作成のため、今表示されている一覧（定数物品を含む）をいったん空にして、氏名・物品を新しく選び直します。よろしいですか？')) return;
      setIsSupplyFixedCreationChoiceOpen(false);
      // 📦 空欄（{}）から始める。まだ触れていない入居者は下書きに含めないことで、保存しても
      //    その入居者の保存済みデータには一切触れない（表示だけstartedBlankでp.suppliesへの
      //    フォールバックを止め、氏名・物品が見えない状態にする）
      setSupplyDraft({ patientSupplies: {}, commonSupplies: [], startedBlank: true });
      // 📜 新規に作り直すため、今までの画面内容と結び付いていた履歴のキーはいったん外す
      setContinuingSupplyTemporaryArchiveKey(null);
      setDisplayedSupplyTemporaryArchiveKey(null);
    } else {
      // 📦 定期作成は月に一回だけ。今月分がすでに定期履歴にある場合は、重ねて新規作成してよいか確認する
      if (supplyMonthlyArchive[liveMonth]) {
        const [y, m] = liveMonth.split('-');
        if (!window.confirm(`${y}年${Number(m)}月分は作成済です。更に新規作成しますか？`)) return;
      }
      // 📦 定期作成を押した瞬間、今画面に映っている一覧はいったん消し、
      //    「先月の定数を引き継いで作成」か「新規作成」かをまず選んでもらう
      setSupplyDraft({ patientSupplies: {}, commonSupplies: [], startedBlank: true });
      setContinuingSupplyMonthlyArchiveMonth(null);
      setDisplayedSupplyMonthlyArchiveMonth(null);
      setIsSupplyFixedCreationChoiceOpen(true);
    }
    // 🧹 定期・臨時どちらのボタンを押した時も、もう一方の履歴継続キーが前のセッションから
    //    残っていると保存ボタンの色判定（hasNoSupplyDraftChanges）が誤って「変更あり」扱いに
    //    なってしまうため、ここで両方とも必ずリセットする（それぞれの分岐内では自分の方だけ
    //    リセットしていたため、同じ画面内で定期→臨時、臨時→定期と切り替えた時に古い方が残っていた）
    setContinuingSupplyMonthlyArchiveMonth(null);
    setDisplayedSupplyMonthlyArchiveMonth(null);
    setContinuingSupplyTemporaryArchiveKey(null);
    setDisplayedSupplyTemporaryArchiveKey(null);
    setSupplyNewCreationKind(kind);
    setIsSupplyNewCreationOpen(true);
    // 📦 定期作成・臨時作成ボタンを押した時点で、選びかけていた氏名・物品があれば一旦リセットし、
    //    まっさらな状態から選び直せるようにする
    setIsSupplyPatientPickerOpen(false);
    setSupplyNewItemDraft(null);
    setIsSupplyKindPickerOpen(false);
    setSupplyCatalogView(false);
    // 📦 新規作成は「今、実際に編集できる月（supplyLiveMonth）」でしか行えないため、
    //    開く時は必ずその月へ戻す（履歴などで別の月を見ていた場合も、氏名・物品の選択エリアがちゃんと現れるように）
    setBillingMonth(liveMonth);
    if (typeof window !== 'undefined') localStorage.setItem('oncall_billing_month', liveMonth);
  };

  // 📦 定期作成の選択画面「新規作成」：空の一覧のまま、氏名・物品の選択画面へ進む
  const handleStartFixedCreationFresh = () => {
    setIsSupplyFixedCreationChoiceOpen(false);
  };

  // 📦 定期作成の選択画面「キャンセル」：定期作成自体をやめて、氏名も物品も何も選ばれていない
  //    まっさらな状態（「作成する」を選んだ直後と同じ状態）に戻す。実データ（保存済みの氏名・物品）は
  //    表示しない＝startedBlankのまま空の下書きにする（保存済みのデータ自体は消えない。見るには履歴から）
  const handleCancelFixedCreationChoice = () => {
    setIsSupplyFixedCreationChoiceOpen(false);
    setIsSupplyNewCreationOpen(false);
    setSupplyDraft({ patientSupplies: {}, commonSupplies: [], startedBlank: true });
  };

  // 📦 定期作成の選択画面「先月の定数を引き継いで作成」：前月の定期履歴から定数の物品だけを取り出し
  //    （臨時は対象外）、曜日×間隔のパターンがある物品は今月の日にちへ生成し直して下書きに入れる
  const handleStartFixedCreationCarryForward = () => {
    // 📅 🗓️「作成日」カレンダーで選んだ月を基準にする（未設定なら今日の実月。supplyLiveMonthは
    //    古いテストなどでずれる可能性があるため使わない）
    const liveMonth = (supplyItemCreationDate || getTodayISO()).slice(0, 7);
    const previousMonth = shiftMonthISO(liveMonth, -1);
    const prevEntry = supplyMonthlyArchive[previousMonth];
    if (!prevEntry) {
      alert(`${formatBillingMonthLabel(previousMonth)}の定期の記録が見つからないため、新規作成として進めます。`);
      setIsSupplyFixedCreationChoiceOpen(false);
      return;
    }
    const carryItem = (s: SupplyItem): SupplyItem => {
      if (s.recurringPattern) {
        const scheduledUseDates = generateRecurringWeekdayDates(liveMonth, s.recurringPattern.weekday, s.recurringPattern.intervalDays).map(date => ({ date, applied: false }));
        const count = scheduledUseDates.length;
        return { ...s, allocated: count, baseAllocated: count, lastResetMonth: liveMonth, stock: count, scheduledUseDates };
      }
      return { ...s, allocated: s.baseAllocated, lastResetMonth: liveMonth, stock: s.baseAllocated, scheduledUseDates: [] };
    };
    const onlyFixed = (list: SupplyItem[]) => list.filter(s => (s.kind || '定数') === '定数').map(carryItem);
    // 📦 前月に定数が無かった入居者は下書きに含めない（[]を入れてしまうと、保存時に
    //    「変更あり」とみなされ、その人の保存済みデータが誤って消えてしまうため）
    setSupplyDraft({
      patientSupplies: Object.fromEntries(
        prevEntry.patients
          .map(sp => [sp.patientId, onlyFixed(sp.supplies)] as const)
          .filter(([, supplies]) => supplies.length > 0)
      ),
      commonSupplies: onlyFixed(prevEntry.commonSupplies),
      startedBlank: true,
    });
    setIsSupplyFixedCreationChoiceOpen(false);
  };

  // 📜 臨時履歴から「日にちを選んで再度追加修正する」：履歴の内容を下書きへ読み込み、保存前と同じ画面
  //    （氏名▼選択・物品カタログ・定数の直接編集など、通常の臨時作成と同じ操作）で続きから編集できるようにする。
  //    ここで保存すると、新しい記録を作らずこの履歴（同じentryKey）へ上書きする
  const handleContinueEditingTemporaryArchive = (key: string) => {
    const entry = supplyTemporaryArchive[key];
    if (!entry) return;
    setSupplyDraft({
      patientSupplies: Object.fromEntries(patients.map(p => {
        const match = entry.patients.find(sp => sp.patientId === p.id);
        return [p.id, match ? match.supplies : []];
      })),
      commonSupplies: entry.commonSupplies,
    });
    setSupplyNewCreationKind('臨時');
    setIsSupplyNewCreationOpen(true);
    // 📦 「履歴をみる」の選択画面から開いた場合も、通常の作成画面へ切り替える
    setSupplyEntryChoice('create');
    setContinuingSupplyTemporaryArchiveKey(key);
    setDisplayedSupplyTemporaryArchiveKey(key);
    // 📅 その記録が作成された日を「作成日」にも反映する（請求物品メモなど、日付ごとに分かれる
    //    情報が、開いた記録の日付と正しく対応するようにするため）
    setSupplyItemCreationDate(key.slice(0, 10));
    if (typeof window !== 'undefined') localStorage.setItem('oncall_supply_item_creation_date', key.slice(0, 10));
    setIsSupplyPatientPickerOpen(false);
    setSupplyNewItemDraft(null);
    setIsSupplyKindPickerOpen(false);
    setSupplyCatalogView(false);
  };

  // 📜 定期履歴から「その月を選んで再度追加修正する」：臨時履歴と同様に、保存前と同じ画面
  //    （氏名▼選択・物品カタログ・定数の直接編集など）で続きから編集できるようにする。
  //    ここで保存すると、その月が今の実データの月（supplyLiveMonth）と違う場合は定期履歴だけを
  //    上書きし（現在進行中の実データには反映しない）、同じ月なら実データにも通常どおり反映する
  const handleContinueEditingMonthlyArchive = (month: string) => {
    const entry = supplyMonthlyArchive[month];
    if (!entry) return;
    setSupplyDraft({
      patientSupplies: Object.fromEntries(patients.map(p => {
        const match = entry.patients.find(sp => sp.patientId === p.id);
        return [p.id, match ? match.supplies : []];
      })),
      commonSupplies: entry.commonSupplies,
    });
    setSupplyNewCreationKind('定数');
    setIsSupplyNewCreationOpen(true);
    // 📦 「履歴をみる」の選択画面から開いた場合も、通常の作成画面へ切り替える
    setSupplyEntryChoice('create');
    setContinuingSupplyMonthlyArchiveMonth(month);
    setBillingMonth(month);
    if (typeof window !== 'undefined') localStorage.setItem('oncall_billing_month', month);
    // 📅 「定期：○年○月分」の見出しは作成日から作られるため、開いた記録の月に作成日も合わせる
    //    （すでにその月の日付が選ばれている場合は、その日付をそのまま使う）
    const nextCreationDate = (supplyItemCreationDate || '').slice(0, 7) === month ? supplyItemCreationDate : `${month}-01`;
    setSupplyItemCreationDate(nextCreationDate);
    if (typeof window !== 'undefined') localStorage.setItem('oncall_supply_item_creation_date', nextCreationDate);
    setIsSupplyPatientPickerOpen(false);
    setSupplyNewItemDraft(null);
    setIsSupplyKindPickerOpen(false);
    setSupplyCatalogView(false);
  };

  // 📦 物品管理のピッカーで入居者を選んだ：物品タイトル一覧（カタログ）をすぐ表示し、そこから選ぶ
  //    （候補にない物品は、一覧内の「✍️ 候補にない物品を手動で記載」から名前・定数を直接入力できる）。
  //    区分は「新規作成」「臨時作成」どちらのボタンで開いたか（supplyNewCreationKind）に従う
  const handleSelectSupplyPatient = (patientId: string) => {
    setSupplyNewItemDraft({ patientId, name: '', allocated: '', unit: '個', kind: supplyNewCreationKind });
    setSupplyCatalogView(null);
    setIsSupplyPatientPickerOpen(true);
  };

  // 📦 すでに物品名が並んでいる人に、新しい物品をもう1件追加したい時（「増加」）に使う
  //    入居者選択の手間を省き、直接この人の物品タイトル一覧（カタログ）を開く
  const handleAddSupplyItemForPatient = (patientId: string) => {
    setSupplyNewItemDraft({ patientId, name: '', allocated: '', unit: '個', kind: '定数' });
    setSupplyCatalogView(null);
    setIsSupplyPatientPickerOpen(true);
  };

  // 📦 すでに一覧に表示されている物品名をクリックした時（書き間違いの修正・別の物品への変更）に使う。
  //    物品名の入力欄を経由せず、物品一覧表（カタログ）を直接開く
  const handleOpenSupplyItemEditor = (patientId: string, supplyId: string, currentName: string, currentAllocated: number, currentUnit: '個' | '箱', currentKind: '定数' | '臨時') => {
    setSupplyNewItemDraft({ patientId, name: currentName, allocated: String(currentAllocated), unit: currentUnit, kind: currentKind, supplyId });
    setIsSupplyPatientPickerOpen(true);
    setSupplyCatalogView(null);
  };

  // 📦 物品名の下書きを保存：supplyIdがあれば既存の物品を書き換え、無ければ新しい物品として追加する
  //    （物品名が無いと一覧に表示されないため、新規追加の場合はこれで初めてその人の名前が物品管理に現れる）
  const handleSaveSupplyNewItem = () => {
    if (!supplyNewItemDraft) return;
    const trimmedName = supplyNewItemDraft.name.trim();
    if (!trimmedName) {
      alert('物品名を入力してください。');
      return;
    }
    const allocated = parseInt(supplyNewItemDraft.allocated, 10) || 0;
    const { patientId, supplyId, unit, kind } = supplyNewItemDraft;

    updateSupplyDraftList(patientId, list => supplyId
      ? list.map(s => s.id === supplyId ? { ...s, name: trimmedName, allocated, baseAllocated: allocated, unit, kind } : s)
      : [...list, { id: `s_${Date.now()}`, name: trimmedName, allocated, baseAllocated: allocated, lastResetMonth: getTodayISO().slice(0, 7), stock: allocated, unit, kind, memo: '', scheduledUseDates: [] }]);
    setSupplyNewItemDraft(null);
    setIsSupplyPatientPickerOpen(false);
    setIsSupplyKindPickerOpen(false);
  };

  // 📜 患者タイムライン：部屋図で氏名をクリックすると、この患者の往診記録だけを時系列で表示する
  // （新しい記録が上・「変化なし」の記録はほぼ無いので、実質的に「何かあった日」だけが並ぶ）
  const [timelinePatientId, setTimelinePatientId] = useState<string | null>(null);
  const handleOpenTimeline = (patientId: string) => {
    setTimelinePatientId(patientId);
  };
  const handleCloseTimeline = () => setTimelinePatientId(null);

  // 🔍 時系列の中で目立たせたい重要キーワード（発熱・転倒など）。該当すると赤字太字で強調表示する
  const TIMELINE_HIGHLIGHT_KEYWORDS = ['発熱', '転倒', '骨折', '膀胱炎', '肺炎', '誤嚥', '入院', '救急搬送', '受診', '褥瘡', '嘔吐', '下血', '意識'];
  const highlightTimelineText = (text: string): boolean => TIMELINE_HIGHLIGHT_KEYWORDS.some(kw => text.includes(kw));

  // ✍️ 時系列：各記録の要約を編集中の下書き（recordIdごと）。AIで生成した内容も、看護師の手直しもここに入る
  const [timelineSummaryDrafts, setTimelineSummaryDrafts] = useState<{ [recordId: string]: string }>({});
  const [timelineSummaryLoading, setTimelineSummaryLoading] = useState<{ [recordId: string]: boolean }>({});

  const handleTimelineSummaryDraftChange = (recordId: string, value: string) => {
    setTimelineSummaryDrafts(prev => ({ ...prev, [recordId]: value }));
  };

  // ✨ AIで要約する：①状態報告・②VS・状態報告・医師指示の内容をサーバー経由でClaudeに送り、簡潔な要約を下書き欄に入れる
  const handleGenerateTimelineSummary = async (recordId: string, reportToDoctor: string, doctorMemo: string) => {
    const sourceText = [reportToDoctor, doctorMemo].filter(Boolean).join('\n');
    if (!sourceText.trim()) {
      alert('要約する元の文章（状態報告・VS・状態変化経過）がありません。');
      return;
    }
    setTimelineSummaryLoading(prev => ({ ...prev, [recordId]: true }));
    try {
      const res = await fetch('/api/summarize-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sourceText }),
      });
      if (!res.ok) throw new Error(`サーバーエラー（${res.status}）`);
      const data = await res.json();
      if (!data.summary) throw new Error('要約結果が空でした');
      setTimelineSummaryDrafts(prev => ({ ...prev, [recordId]: data.summary }));
    } catch (e: any) {
      alert(`⚠️ AI要約に失敗しました。\n${e?.message || ''}\n\n手動で入力・編集していただくことも可能です。`);
    } finally {
      setTimelineSummaryLoading(prev => ({ ...prev, [recordId]: false }));
    }
  };

  // 💾 時系列：編集した要約（AI生成 or 手動修正）を、この患者のvisitHistoryの該当記録に保存する
  const handleSaveTimelineSummary = (patientId: string, recordId: string) => {
    const summaryText = (timelineSummaryDrafts[recordId] || '').trim();
    setPatients(prev => prev.map(p => {
      if (p.id !== patientId) return p;
      return {
        ...p,
        visitHistory: p.visitHistory.map(record => record.id === recordId
          ? { ...record, timelineSummary: summaryText, timelineSummaryEditedBy: loggedInUser || '不明なユーザー', timelineSummaryEditedAt: formatNowTimestamp() }
          : record
        ),
      };
    }));
  };

  // 🏠 入居者を部屋から削除（空室に戻す）
  const handleVacateRoom = (patientId: string, patientLabel: string) => {
    const confirmVacate = window.confirm(`${patientLabel} を退去（空室に戻す）扱いにします。よろしいですか？\n※この操作は取り消せません。`);
    if (!confirmVacate) return;

    // 🔒 誤操作防止のため、退去（削除）には管理者パスワードを必須にする
    const MASTER_PASSWORD = 'master999';
    const inputPassword = prompt('⚠️ 入居者データの削除には管理者パスワードが必要です。\nパスワードを入力してください：');
    if (inputPassword === null) return;
    if (inputPassword !== MASTER_PASSWORD) {
      alert('❌ パスワードが正しくありません。削除は取り消されました。');
      return;
    }

    setPatients(prev => prev.filter(p => p.id !== patientId));
    setEmergencyModalPatientId(prev => (prev === patientId ? null : prev));
    logAction('', patientLabel, '退去', '入居者データを削除（空室に戻す）');
  };

  // 📎 部屋図でスキャン・添付した書類を、ダブルクリックで閲覧するためのビューア
  const [viewingAttachedFile, setViewingAttachedFile] = useState<{ name: string; type: 'image' | 'video' | 'file'; dataUrl: string } | null>(null);

  // 📎 選んだファイル（スキャナー・カメラ・既存の画像/PDF）を読み込み、患者の添付書類として追加する
  const handleAttachFiles = (patientId: string, fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    Array.from(fileList).forEach(file => {
      const fileType: 'image' | 'video' | 'file' = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file';
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setPatients(prev => prev.map(p => p.id === patientId
          ? touchLastEdited({ ...p, attachedFiles: [...p.attachedFiles, { id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, name: file.name, type: fileType, dataUrl }] })
          : p
        ));
      };
      reader.readAsDataURL(file);
    });
  };

  // 📎 使わなくなった添付書類を削除する
  const handleRemoveAttachedFile = (patientId: string, fileId: string) => {
    setPatients(prev => prev.map(p => p.id === patientId
      ? touchLastEdited({ ...p, attachedFiles: p.attachedFiles.filter(f => f.id !== fileId) })
      : p
    ));
  };

  // 📅 次回往診サイクルを開始する（2週間ごとの定期往診に合わせて、バイタル・指示カルテ・観察要点・物品使用数をリセットする）
  const handleStartNextVisitCycle = () => {
    if (patients.length === 0) {
      alert('入居者データがありません。');
      return;
    }

    // 🗓️ 診療日（nextVisitDate）が今日より先の未来日の場合、その日がまだ来ていないのに
    //    次のサイクルへ進めさせない（今画面にある内容は、まだ来ていない診療日に向けて準備中の記録のため）
    const nextVisitIso = parseJapaneseDateToISO(nextVisitDate);
    if (nextVisitIso && nextVisitIso > getTodayISO()) {
      alert('未来日は更新できません');
      return;
    }

    const today = new Date();
    const todayDateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

    const confirmStart = window.confirm(
      `次回往診サイクルを開始します。\n\n・今回の記録（バイタル・医師指示メモ・指示内容・観察要点・物品使用数）は「往診記録」として保存され、消えません\n・1.バイタルの数値（KT/BP/SpO2/P）は次回入力用に空になります\n・報告内容欄には、今回の医師指示メモが薄い文字で表示されます\n・2.指示カルテ（医師指示メモ・指示内容）、3.観察要点、5.物品管理の使用数は次回入力用に空になります\n\n※長期的な意思決定情報（蘇生拒否・胃ろう等）や緊急時対応サマリーシートは変更されません。\n\nこの操作は全${patients.length}名分に適用されます。よろしいですか？`
    );
    if (!confirmStart) return;

    const MASTER_PASSWORD = 'master999';
    const inputPassword = prompt('⚠️ 全入居者データの一括リセットには管理者パスワードが必要です。\nパスワードを入力してください：');
    if (inputPassword === null) return;
    if (inputPassword !== MASTER_PASSWORD) {
      alert('❌ パスワードが正しくありません。操作は取り消されました。');
      return;
    }

    const visitTimestamp = Date.now();

    setPatients(prev => prev.map(p => {
      // 📋 リセットする前に、今回の内容をそのまま「往診記録」として保存する（消去せず履歴として蓄積）
      const snapshot: VisitRecord = {
        id: `visit_${p.id}_${visitTimestamp}`,
        date: todayDateStr,
        timestamp: visitTimestamp,
        kt: p.kt,
        bp: p.bp,
        spo2: p.spo2,
        p: p.p,
        reportToDoctor: p.reportToDoctor,
        doctorMemo: p.doctorMemo,
        doctorOrder: p.doctorOrder,
        orderStatus: p.orderStatus,
        orderCreatedBy: p.orderCreatedBy,
        orderPeriods: p.orderPeriods,
        prnMedications: p.prnMedications,
        observationList: p.observationList,
        observationStatus: p.observationStatus,
        lastEditedBy: p.lastEditedBy,
        lastEditedAt: p.lastEditedAt,
        // 📦 物品管理は「使用数（周期ごとにリセット）」から「在庫（常時保持・使用予定日で自動減算）」の
        // 管理方式に変わったため、周期ごとの使用数スナップショットはもう記録しない
        suppliesUsedSnapshot: [],
      };

      return {
        ...p,
        // 過去の記録として先頭に追加（新しいものが上）
        visitHistory: [snapshot, ...p.visitHistory],
        // 1. バイタル：数値は空にし、①報告内容欄には今回の医師指示メモを薄いヒント文字として残す
        kt: '',
        bp: '',
        spo2: '',
        p: '',
        reportToDoctor: '',
        prevDoctorMemoHint: p.doctorMemo.trim() || p.prevDoctorMemoHint,
        // 2. 指示カルテ：医師指示メモ・指示内容をクリア
        doctorMemo: '',
        doctorOrder: '',
        orderStatus: {},
        orderCreatedBy: {},
        orderPeriods: {},
        dismissedSuggestions: [],
        isChangedInstruction: false,
        // 3. 観察要点：頓用薬の選択・観察項目チェックリストをクリア
        prnMedications: {},
        observationList: '',
        observationStatus: {},
        dismissedObservations: [],
        lastEditedBy: loggedInUser || '不明なユーザー',
        lastEditedAt: todayDateStr,
        // 5. 物品管理：在庫は周期をまたいで保持し続けるため、次回に更新してもリセットしない
      };
    }));

    setHandoverNote('【全体連絡】本日大きなトラブルなし。よろしくお願いいたします。');

    // 🗓️ 往診日を自動的に2週間後の日付へ更新（手動で書き直すことも可能）
    const nextDate = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
    const autoNextVisitDate = `${nextDate.getFullYear()}年${nextDate.getMonth() + 1}月${nextDate.getDate()}日`;
    setNextVisitDate(autoNextVisitDate);
    if (typeof window !== 'undefined') {
      localStorage.setItem('oncall_next_visit_date', autoNextVisitDate);
    }

    logAction('', '全員', '往診サイクル開始', `次回往診に向けて全${patients.length}名分のバイタル・指示カルテ・観察要点・物品使用数をリセットしました`);
    alert('✅ 次回往診サイクルを開始しました。');
  };

  // 🚨 緊急時対応サマリーシートを開く（現在のデータを下書きにコピーする）
  // 🎂 開くたびに本日の日付を基準に生年月日から年齢を計算し直すので、しばらく開いていなくても年齢は自動的に最新になる
  const handleOpenEmergencyModal = (p: Patient) => {
    setEmergencyModalPatientId(p.id);
    const summary = JSON.parse(JSON.stringify(p.emergencySummary)) as EmergencySummary;
    setSummaryDraft({
      patientId: p.id,
      name: stripHonorificSuffix(p.name),
      age: calculateAge(summary.birthDate),
      gender: p.gender,
      summary,
    });
    // 🗓️ 既に生年月日が入っていれば、それが属する元号（なければ西暦）を選択状態にして入力欄を復元する。
    //    入力済みなら和暦表記の確定表示から始め、未入力ならすぐ入力できるよう入力欄を開いておく
    const detectedMode = detectEraModeForISO(summary.birthDate);
    setBirthDateEraMode(detectedMode);
    setBirthDateRawInput(isoToBirthDateDigits(summary.birthDate, detectedMode));
    setIsBirthDateEditing(!summary.birthDate);
  };

  // 🗓️ 生年月日欄の暦（西暦／元号）を切り替える。数字入力欄は桁数が変わるためリセットする
  const handleBirthDateEraModeChange = (mode: BirthDateEraMode) => {
    setBirthDateEraMode(mode);
    setBirthDateRawInput('');
    handleDraftSummaryChange('birthDate', '');
  };

  // ⌨️ 生年月日欄への数字入力（西暦なら8桁、和暦なら6桁）を処理する。桁が揃って実在する日付になった時点で下書きに反映し、年齢も自動計算される。
  //    入力が完了して実在する日付になったら、暦切り替えボタンなどの入力UIは自動的に畳んで和暦表記の確定表示だけにする
  const handleBirthDateRawInputChange = (rawValue: string) => {
    const maxDigits = birthDateEraMode === '西暦' ? 8 : 6;
    const digits = rawValue.replace(/[^0-9]/g, '').slice(0, maxDigits);
    setBirthDateRawInput(digits);
    const iso = digitsToISOBirthDate(digits, birthDateEraMode);
    handleDraftSummaryChange('birthDate', iso);
    if (iso) {
      setIsBirthDateEditing(false);
    }
  };

  // 🚨 保存せずに閉じる（変更があれば確認する）
  const handleCloseEmergencyModal = () => {
    if (!summaryDraft) {
      setEmergencyModalPatientId(null);
      return;
    }
    // ℹ️ ageは生年月日(summary.birthDate)から自動計算される値なので、変更検知にはsummaryの比較だけで十分（別途ageを比較すると、
    //    開いた瞬間の自動再計算だけで「変更あり」と誤判定してしまう）。nameも、下書き側は敬称を外した状態
    //    （stripHonorificSuffix）で持っているため、比較する時は元のnameからも敬称を外してから比べる
    //    （外さないと、敬称が付いているだけで常に「変更あり」と誤判定してしまう）
    const original = patients.find(p => p.id === summaryDraft.patientId);
    const isChanged = original
      ? JSON.stringify({ name: stripHonorificSuffix(original.name), gender: original.gender, summary: original.emergencySummary }) !==
        JSON.stringify({ name: summaryDraft.name, gender: summaryDraft.gender, summary: summaryDraft.summary })
      : false;

    if (isChanged) {
      const confirmDiscard = window.confirm('保存されていない変更があります。\n保存せずに閉じますか？');
      if (!confirmDiscard) return;
    }
    setEmergencyModalPatientId(null);
    setSummaryDraft(null);
  };

  // 🚨 保存する：下書きの内容を実データへ反映し、更新日・更新者を自動記録する
  const handleSaveEmergencySummary = () => {
    if (!summaryDraft) return;
    const today = new Date();
    const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

    setPatients(prev => prev.map(p => {
      if (p.id !== summaryDraft.patientId) return p;
      return {
        ...p,
        // 🈂️ 姓・名を2つの欄に分けたことで、片方が空の時は結合した文字列の前後に余分な空白が付くことがあるため、
        // 実際にPatientへ保存する時（表示・他画面での氏名比較に使われる）はtrimして取り除く。
        // 敬称「様」は入力欄には含めていない（画面上は固定表示のみ）ため、保存時に付け直す
        name: appendHonorificSuffix(summaryDraft.name.trim()),
        age: summaryDraft.age,
        gender: summaryDraft.gender,
        emergencySummary: {
          ...summaryDraft.summary,
          nameKana: summaryDraft.summary.nameKana.trim(),
          lastUpdated: dateStr,
          updatedBy: loggedInUser || '不明なユーザー',
        },
      };
    }));

    setEmergencyModalPatientId(null);
    setSummaryDraft(null);
  };

  // 🚨 下書きの基本項目（氏名）を更新。年齢は生年月日から自動計算されるため、ここでは編集しない
  const handleDraftFieldChange = (field: 'name', value: string) => {
    setSummaryDraft(prev => prev ? { ...prev, [field]: value } : prev);
  };

  // 🚨 下書きのサマリー項目（文字列）を更新
  // 🎂 生年月日(birthDate)を変更した場合は、その場で年齢も自動的に再計算する
  const handleDraftSummaryChange = (key: keyof EmergencySummary, value: string) => {
    setSummaryDraft(prev => {
      if (!prev) return prev;
      const nextSummary = { ...prev.summary, [key]: value };
      const nextAge = key === 'birthDate' ? calculateAge(value) : prev.age;
      return { ...prev, age: nextAge, summary: nextSummary };
    });
  };

  // 🗓️ 感染症「最終検査日」：カレンダーマークから日付を選んで入力できるようにする
  const [isLastTestDateCalendarOpen, setIsLastTestDateCalendarOpen] = useState(false);
  const [lastTestDateCalendarMonth, setLastTestDateCalendarMonth] = useState<string>('');
  const openLastTestDateCalendar = () => {
    if (!summaryDraft) return;
    const iso = parseJapaneseDateToISO(summaryDraft.summary.lastTestDate) || getTodayISO();
    setLastTestDateCalendarMonth(iso.slice(0, 7));
    setIsLastTestDateCalendarOpen(true);
  };
  const shiftLastTestDateCalendarMonth = (deltaMonths: number) => {
    setLastTestDateCalendarMonth(prev => {
      const [y, m] = (prev || getTodayISO().slice(0, 7)).split('-').map(Number);
      const d = new Date(y, m - 1 + deltaMonths, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });
  };
  const handleSelectLastTestDate = (iso: string) => {
    handleDraftSummaryChange('lastTestDate', formatISOToJapaneseDate(iso));
    setIsLastTestDateCalendarOpen(false);
  };

  // 🩺 緊急時対応サマリーシートの「かかりつけ医」：一度入力した医院名・担当医・〒・住所・TELの組み合わせは履歴として
  // 保存し、次回以降は医院名または担当医の欄をクリックすると一覧から選び直せる（選ぶと〒・住所・TELもセットで
  // 自動入力され、その後も手動で書き直せる。初回は履歴が空。状態自体はマウント時の復元処理と一緒にできるよう
  // 別の場所で宣言・復元している）
  const handlePrimaryDoctorBlur = () => {
    if (typeof window === 'undefined' || !summaryDraft) return;
    const clinic = summaryDraft.summary.primaryDoctorClinic.trim();
    const name = summaryDraft.summary.primaryDoctorName.trim();
    const postalCode = summaryDraft.summary.primaryDoctorPostalCode.trim();
    const address = summaryDraft.summary.primaryDoctorAddress.trim();
    const tel = summaryDraft.summary.primaryDoctorTel.trim();
    if (!clinic && !name) return;
    const alreadySaved = primaryDoctorHistory.some(h => h.clinic === clinic && h.name === name);
    if (alreadySaved) return;
    const nextHistory = [{ id: `pdh_${Date.now()}`, clinic, name, postalCode, address, tel }, ...primaryDoctorHistory].slice(0, 10);
    setPrimaryDoctorHistory(nextHistory);
    localStorage.setItem('oncall_primary_doctor_history', JSON.stringify(nextHistory));
  };
  const handleSelectPrimaryDoctorHistory = (entry: { clinic: string; name: string; postalCode: string; address: string; tel: string }) => {
    handleDraftSummaryChange('primaryDoctorClinic', entry.clinic);
    handleDraftSummaryChange('primaryDoctorName', entry.name);
    handleDraftSummaryChange('primaryDoctorPostalCode', entry.postalCode);
    handleDraftSummaryChange('primaryDoctorAddress', entry.address);
    handleDraftSummaryChange('primaryDoctorTel', entry.tel);
    setIsPrimaryDoctorHistoryOpen(false);
  };
  // ✏️ かかりつけ医の履歴一覧から、不要になった1件だけを削除する
  const handleDeletePrimaryDoctorHistory = (id: string) => {
    const nextHistory = primaryDoctorHistory.filter(h => h.id !== id);
    setPrimaryDoctorHistory(nextHistory);
    if (typeof window !== 'undefined') {
      localStorage.setItem('oncall_primary_doctor_history', JSON.stringify(nextHistory));
    }
  };
  // 🩺 医院名欄に、これまで履歴に保存した医院名とそのまま同じ文字列を入力し終えたら、一覧から選ばなくても
  // 自動的に担当医・〒・住所・TELをまとめて入力する（入力後も引き続き手動で書き直せる）
  const handlePrimaryDoctorClinicChange = (value: string) => {
    handleDraftSummaryChange('primaryDoctorClinic', value);
    const matched = primaryDoctorHistory.find(h => h.clinic === value.trim());
    if (matched) handleSelectPrimaryDoctorHistory(matched);
  };
  // ✏️ かかりつけ医の履歴一覧のその場編集：編集を開始する／入力内容を変更する／保存する／取り消す
  const handleStartEditPrimaryDoctorHistory = (entry: PrimaryDoctorHistoryEntry) => {
    setEditingPrimaryDoctorHistoryId(entry.id);
    setPrimaryDoctorHistoryEditDraft({ clinic: entry.clinic, name: entry.name, postalCode: entry.postalCode, address: entry.address, tel: entry.tel });
  };
  const handleChangePrimaryDoctorHistoryEditDraft = (field: keyof Omit<PrimaryDoctorHistoryEntry, 'id'>, value: string) => {
    setPrimaryDoctorHistoryEditDraft(prev => ({ ...prev, [field]: value }));
  };
  const handleCancelEditPrimaryDoctorHistory = () => {
    setEditingPrimaryDoctorHistoryId(null);
  };
  const handleSaveEditPrimaryDoctorHistory = () => {
    if (typeof window === 'undefined' || !editingPrimaryDoctorHistoryId) return;
    const clinic = primaryDoctorHistoryEditDraft.clinic.trim();
    const name = primaryDoctorHistoryEditDraft.name.trim();
    if (!clinic && !name) return;
    const nextHistory = primaryDoctorHistory.map(h => h.id === editingPrimaryDoctorHistoryId
      ? { ...h, clinic, name, postalCode: primaryDoctorHistoryEditDraft.postalCode.trim(), address: primaryDoctorHistoryEditDraft.address.trim(), tel: primaryDoctorHistoryEditDraft.tel.trim() }
      : h);
    setPrimaryDoctorHistory(nextHistory);
    localStorage.setItem('oncall_primary_doctor_history', JSON.stringify(nextHistory));
    setEditingPrimaryDoctorHistoryId(null);
  };
  // ➕ かかりつけ医の履歴一覧に、メインの氏名欄を経由せずその場で新しい1件を追加する
  const handleChangeNewPrimaryDoctorEntryDraft = (field: keyof Omit<PrimaryDoctorHistoryEntry, 'id'>, value: string) => {
    setNewPrimaryDoctorEntryDraft(prev => ({ ...prev, [field]: value }));
  };
  const handleAddNewPrimaryDoctorHistoryEntry = () => {
    if (typeof window === 'undefined') return;
    const clinic = newPrimaryDoctorEntryDraft.clinic.trim();
    const name = newPrimaryDoctorEntryDraft.name.trim();
    if (!clinic && !name) return;
    const nextHistory = [
      { id: `pdh_${Date.now()}`, clinic, name, postalCode: newPrimaryDoctorEntryDraft.postalCode.trim(), address: newPrimaryDoctorEntryDraft.address.trim(), tel: newPrimaryDoctorEntryDraft.tel.trim() },
      ...primaryDoctorHistory,
    ].slice(0, 10);
    setPrimaryDoctorHistory(nextHistory);
    localStorage.setItem('oncall_primary_doctor_history', JSON.stringify(nextHistory));
    setNewPrimaryDoctorEntryDraft({ clinic: '', name: '', postalCode: '', address: '', tel: '' });
  };

  // 🚑 緊急時対応サマリーシートの「救急搬送希望先」：一度入力した病院名・郵便番号・住所・TELの組み合わせは
  // 履歴として保存し、次回以降は病院名の欄をクリックすると一覧から選び直せる（初回は履歴が空）
  const handleEmergencyHospitalBlur = () => {
    if (typeof window === 'undefined' || !summaryDraft) return;
    const name = summaryDraft.summary.emergencyHospitalName.trim();
    if (!name) return;
    const postalCode = summaryDraft.summary.emergencyHospitalPostalCode.trim();
    const address = summaryDraft.summary.emergencyHospitalAddress.trim();
    const tel = summaryDraft.summary.emergencyHospitalTel.trim();
    const alreadySaved = emergencyHospitalHistory.some(h => h.name === name);
    if (alreadySaved) return;
    const nextHistory = [{ id: `ehh_${Date.now()}`, name, postalCode, address, tel }, ...emergencyHospitalHistory].slice(0, 10);
    setEmergencyHospitalHistory(nextHistory);
    localStorage.setItem('oncall_emergency_hospital_history', JSON.stringify(nextHistory));
  };
  const handleSelectEmergencyHospitalHistory = (entry: { name: string; postalCode: string; address: string; tel: string }) => {
    handleDraftSummaryChange('emergencyHospitalName', entry.name);
    handleDraftSummaryChange('emergencyHospitalPostalCode', entry.postalCode);
    handleDraftSummaryChange('emergencyHospitalAddress', entry.address);
    handleDraftSummaryChange('emergencyHospitalTel', entry.tel);
    setIsEmergencyHospitalHistoryOpen(false);
  };
  // ✏️ 救急搬送希望先の履歴一覧から、不要になった1件だけを削除する
  const handleDeleteEmergencyHospitalHistory = (id: string) => {
    const nextHistory = emergencyHospitalHistory.filter(h => h.id !== id);
    setEmergencyHospitalHistory(nextHistory);
    if (typeof window !== 'undefined') {
      localStorage.setItem('oncall_emergency_hospital_history', JSON.stringify(nextHistory));
    }
  };
  // ✏️ 救急搬送希望先の履歴一覧のその場編集：編集を開始する／入力内容を変更する／保存する／取り消す
  const handleStartEditEmergencyHospitalHistory = (entry: EmergencyHospitalHistoryEntry) => {
    setEditingEmergencyHospitalHistoryId(entry.id);
    setEmergencyHospitalHistoryEditDraft({ name: entry.name, postalCode: entry.postalCode, address: entry.address, tel: entry.tel });
  };
  const handleChangeEmergencyHospitalHistoryEditDraft = (field: keyof Omit<EmergencyHospitalHistoryEntry, 'id'>, value: string) => {
    setEmergencyHospitalHistoryEditDraft(prev => ({ ...prev, [field]: value }));
  };
  const handleCancelEditEmergencyHospitalHistory = () => {
    setEditingEmergencyHospitalHistoryId(null);
  };
  const handleSaveEditEmergencyHospitalHistory = () => {
    if (typeof window === 'undefined' || !editingEmergencyHospitalHistoryId) return;
    const name = emergencyHospitalHistoryEditDraft.name.trim();
    if (!name) return;
    const nextHistory = emergencyHospitalHistory.map(h => h.id === editingEmergencyHospitalHistoryId
      ? { ...h, name, postalCode: emergencyHospitalHistoryEditDraft.postalCode.trim(), address: emergencyHospitalHistoryEditDraft.address.trim(), tel: emergencyHospitalHistoryEditDraft.tel.trim() }
      : h);
    setEmergencyHospitalHistory(nextHistory);
    localStorage.setItem('oncall_emergency_hospital_history', JSON.stringify(nextHistory));
    setEditingEmergencyHospitalHistoryId(null);
  };
  // ➕ 救急搬送希望先の履歴一覧に、メインの氏名欄を経由せずその場で新しい1件を追加する
  const handleChangeNewEmergencyHospitalEntryDraft = (field: keyof Omit<EmergencyHospitalHistoryEntry, 'id'>, value: string) => {
    setNewEmergencyHospitalEntryDraft(prev => ({ ...prev, [field]: value }));
  };
  const handleAddNewEmergencyHospitalHistoryEntry = () => {
    if (typeof window === 'undefined') return;
    const name = newEmergencyHospitalEntryDraft.name.trim();
    if (!name) return;
    const nextHistory = [
      { id: `ehh_${Date.now()}`, name, postalCode: newEmergencyHospitalEntryDraft.postalCode.trim(), address: newEmergencyHospitalEntryDraft.address.trim(), tel: newEmergencyHospitalEntryDraft.tel.trim() },
      ...emergencyHospitalHistory,
    ].slice(0, 10);
    setEmergencyHospitalHistory(nextHistory);
    localStorage.setItem('oncall_emergency_hospital_history', JSON.stringify(nextHistory));
    setNewEmergencyHospitalEntryDraft({ name: '', postalCode: '', address: '', tel: '' });
  };
  // 🚑 病院名欄に、これまで履歴に保存した病院名とそのまま同じ文字列を入力し終えたら、一覧から選ばなくても
  // 自動的に〒・住所・TELをまとめて入力する（入力後も引き続き手動で書き直せる）
  const handleEmergencyHospitalNameChange = (value: string) => {
    handleDraftSummaryChange('emergencyHospitalName', value);
    const matched = emergencyHospitalHistory.find(h => h.name === value.trim());
    if (matched) handleSelectEmergencyHospitalHistory(matched);
  };

  // 🈂️ 氏名の編集前後を比較し、ふりがな（currentKana）を自動更新してsetKanaへ渡す。readingは今回の編集で捉えた
  // 読み（「様」は除く。変換を経ない純粋な削除の場合は空文字）。氏名を丸ごと打ち直した場合はreadingで全体を
  // 上書きし、1つの文節だけの書き換え・追記・削除ならふりがなの対応する文節だけを差し替え・挿入・削除する
  // （他の文節はそのまま残す）。緊急時対応サマリーシートの氏名欄・新規入居者登録の氏名欄など、氏名とふりがなの
  // ペアを持つ入力欄であればどこからでも共通で使えるよう、対象のふりがなをcurrentKana/setKanaで受け取る形にしている。
  // midName（省略時はoldNameと同じ＝差分なし扱い）は今回の変換が始まる直前の氏名で、文節の一部の文字だけを
  // 打ち直す編集（既存文字は残したまま）を検出し、その場合はふりがなの自動更新をスキップするために使う
  // 🈂️ oldName（変換開始前の氏名。バックスペース等の削除も含む）とmidName（今回の変換直前の氏名）を比較し、
  // 「バックスペース等でこの変換が始まる前に消えていた範囲」を求める（共通の接頭辞・接尾辞の“外側”）。
  // 単語をダブルクリックなどで選択してから、削除を挟まずそのまま変換で上書きした場合（プレーンな削除が無い）は、
  // この比較だけでは「まだ何も消えていない」ように見えてしまう（選択されていた古い文字は、変換が確定する
  // この瞬間まではmidName上にそのまま残っているため）。そこで、今回の変換が始まった時点の選択範囲
  // （midSelStart～midSelEnd、midName基準）もoldName基準の位置に変換し、両方を合わせた範囲を
  // 「今回の変換で実際に変わった範囲」とみなす。戻り値はoldName基準の[changedStart, changedEnd)
  const computeChangedRangeInOldName = (oldName: string, midName: string, midSelStart: number, midSelEnd: number) => {
    let commonPrefix = 0;
    const maxCommon = Math.min(oldName.length, midName.length);
    while (commonPrefix < maxCommon && oldName[commonPrefix] === midName[commonPrefix]) commonPrefix++;
    let commonSuffix = 0;
    const maxSuffix = maxCommon - commonPrefix;
    while (
      commonSuffix < maxSuffix &&
      oldName[oldName.length - 1 - commonSuffix] === midName[midName.length - 1 - commonSuffix]
    ) commonSuffix++;

    const mapMidToOld = (pos: number) => (pos <= commonPrefix ? pos : pos + (oldName.length - midName.length));
    let changedStart = mapMidToOld(midSelStart);
    let changedEnd = mapMidToOld(midSelEnd);
    if (midName.length < oldName.length) {
      changedStart = Math.min(changedStart, commonPrefix);
      changedEnd = Math.max(changedEnd, oldName.length - commonSuffix);
    }
    // 🈂️ 通常はここまでの計算で範囲は必ず[0, oldName.length]に収まるはずだが、想定外の入力（フォーカスが
    // 一度も発生しないまま編集イベントだけ発生した等）でも配列外参照や誤判定を起こさないよう範囲内に丸める
    changedStart = Math.max(0, Math.min(changedStart, oldName.length));
    changedEnd = Math.max(0, Math.min(changedEnd, oldName.length));
    return { changedStart, changedEnd };
  };

  // 🈂️ 戻り値はこの関数がふりがなを更新できたかどうか（true=更新した／false=判断できず何もしなかった）。
  // falseの場合、呼び出し側で「辞書を使った読みの推測（kuromoji）」にフォールバックできるようにするための印
  const applyNameEditToKana = (
    oldName: string, newName: string, reading: string,
    currentKana: string, setKana: (next: string) => void,
    midName: string = oldName,
    midSelStart: number = midName.length, midSelEnd: number = midName.length
  ): boolean => {
    const edit = classifyNameEdit(oldName, newName);
    if (edit.kind === 'whole') {
      if (!reading) return false;
      // 🈂️ 氏名にスペースが無く（例：「斎藤裕子」を1つの文節として扱わざるを得ない場合）、その一部だけを
      // 打ち直した時も文節が一致せず'whole'と判定されてしまう。この時、旧氏名の一部が本当にまだ残っている
      // （＝部分的な打ち直し）場合にそのままreadingで全体を上書きすると、変わっていない部分の正しい読みが
      // 消えてしまう（例：「ゆうこ」が消える）。oldName全体がこの変換でちょうど置き換わった場合だけ全体を
      // 上書きし、一部しか変わっていない場合は誤って消してしまわないよう自動更新を行わない
      const { changedStart, changedEnd } = computeChangedRangeInOldName(oldName, midName, midSelStart, midSelEnd);
      if (!(changedStart <= 0 && changedEnd >= oldName.length)) return false;
      setKana(reading);
      return true;
    } else if (edit.kind === 'appendAtEnd' || edit.kind === 'prependAtStart') {
      // 🈂️ 旧氏名がスペースなしでそのまま新氏名の先頭または末尾に残っている（＝既存の文節は書き変わっておらず、
      //    続けて新しい文節をスペースを打たずに追加しただけ）ケース。既存の文節のふりがなはそのまま残し、
      //    今回の読みを新しい文節として先頭または末尾に追加する
      if (!reading) return false;
      const kanaSegments = currentKana.split(/\s+/).filter(Boolean);
      if (edit.kind === 'appendAtEnd') kanaSegments.push(reading); else kanaSegments.unshift(reading);
      setKana(kanaSegments.join(' '));
      return true;
    } else if (edit.kind === 'replaceSegment') {
      if (!reading) return false;
      const segIndex = edit.index;
      const oldSeg = splitNameIntoSegments(oldName)[segIndex];
      if (oldSeg) {
        const { changedStart, changedEnd } = computeChangedRangeInOldName(oldName, midName, midSelStart, midSelEnd);
        // 旧文節がこの範囲に完全に収まっていなければ一部の文字がまだ残っている（＝部分的な打ち直し）とみなし、
        // 誤って正しいふりがなを消してしまわないよう自動更新を行わない
        if (!(oldSeg.start >= changedStart && oldSeg.end <= changedEnd)) return false;
      }
      const kanaSegments = currentKana.split(/\s+/).filter(Boolean);
      while (kanaSegments.length <= segIndex) kanaSegments.push('');
      kanaSegments[segIndex] = reading;
      setKana(kanaSegments.join(' '));
      return true;
    } else if (edit.kind === 'insertSegment') {
      if (!reading) return false;
      const insertIndex = edit.index;
      const kanaSegments = currentKana.split(/\s+/).filter(Boolean);
      kanaSegments.splice(insertIndex, 0, reading);
      setKana(kanaSegments.join(' '));
      return true;
    } else if (edit.kind === 'removeSegment') {
      // 🈂️ 文節が丸ごと消えた：対応するふりがなの文節も一緒に削除し、消えた文節の読みが取り残されないようにする
      const removeIndex = edit.index;
      const kanaSegments = currentKana.split(/\s+/).filter(Boolean);
      if (removeIndex >= kanaSegments.length) return false;
      kanaSegments.splice(removeIndex, 1);
      setKana(kanaSegments.join(' '));
      return true;
    }
    // edit.kind === 'ambiguous'（複数の文節が入り乱れて変わった等）の場合は、誤った読みを作らないよう何もしない
    return false;
  };

  // 🈂️ 「姓」「名」など、氏名を複数の入力ボックスに分けた場合の共通イベントハンドラをまとめて作る。
  // ボックスごとに対応するふりがな（getKana/setKana）だけを渡せば、あとは1つの氏名欄の時と全く同じ
  // 仕組み（IME変換の読み取り・氏名欄が空になった時の読みクリアなど）がそのまま使える
  const createNameKanaHandlers = (getName: () => string, getKana: () => string, setKana: (next: string) => void) => ({
    onFocus: (e: React.FocusEvent<HTMLInputElement>) => {
      nameAtFocusStart = e.currentTarget.value;
    },
    onCompositionStart: (e: React.CompositionEvent<HTMLInputElement>) => {
      nameKanaLiveHiragana = '';
      nameKanaConfirmedReading = '';
      nameKanaHasConfirmedSegment = false;
      nameBeforeComposition = e.currentTarget.value;
      nameCompositionSelStart = e.currentTarget.selectionStart ?? nameBeforeComposition.length;
      nameCompositionSelEnd = e.currentTarget.selectionEnd ?? nameCompositionSelStart;
      // 🈂️ このボックスが空の状態から新しく変換を始める＝前の内容は変換を経ずに消されている。
      //    古い読みが取り残されないよう、対応するふりがなもここで空にしておく
      if (nameBeforeComposition === '' && getKana() !== '') setKana('');
    },
    onCompositionUpdate: (e: React.CompositionEvent<HTMLInputElement>) => {
      if (/^[ぁ-ゖー 　]*$/.test(e.data)) {
        if (e.data.length >= nameKanaLiveHiragana.length) nameKanaLiveHiragana = e.data;
      } else {
        const hiraganaSuffix = e.data.match(/[ぁ-ゖー 　]*$/)?.[0] || '';
        if (!nameKanaHasConfirmedSegment) {
          nameKanaConfirmedReading = nameKanaLiveHiragana;
          nameKanaHasConfirmedSegment = true;
          nameKanaLiveHiragana = hiraganaSuffix;
        } else if (hiraganaSuffix.length >= nameKanaLiveHiragana.length) {
          nameKanaLiveHiragana = hiraganaSuffix;
        }
      }
    },
    onCompositionEnd: (e: React.CompositionEvent<HTMLInputElement>) => {
      // 🈂️ IMEによっては、変換の途中で「い」など1文字だけが一旦漢字候補として仮確定し、その後そのまま
      // 続けて全体（例：「いけだ」）がひらがなで再表示されることがある。この時、確定枠（「い」）と
      // 追跡中の文字列（「いけだ」）の両方に同じ先頭部分が重複して入ってしまい、「いいけだ」のように
      // 読みが二重になる。追跡中の文字列が確定枠の内容をすでに含んでいる（＝重複している）場合は、
      // 確定枠を使わず追跡中の文字列だけを採用することで、この重複を防ぐ
      const combinedReading = nameKanaConfirmedReading && nameKanaLiveHiragana.startsWith(nameKanaConfirmedReading)
        ? nameKanaLiveHiragana
        : nameKanaConfirmedReading + nameKanaLiveHiragana;
      const reading = combinedReading.replace(/[\s　]*さま[\s　]*$/, '').trim();
      const newName = e.currentTarget.value;
      const prevOldName = nameAtFocusStart;
      const handled = applyNameEditToKana(
        prevOldName, newName, reading,
        getKana(), setKana,
        nameBeforeComposition, nameCompositionSelStart, nameCompositionSelEnd
      );
      nameAtFocusStart = newName;
      nameKanaLiveHiragana = '';
      nameKanaConfirmedReading = '';
      nameKanaHasConfirmedSegment = false;
      // 🈂️ 文節の一部だけの書き換えなど、上の仕組みだけでは読みを判断できなかった時は、辞書内蔵ライブラリ
      // （kuromoji）で氏名欄全体を解析し、読みを推測してあてはめる（通信・課金は発生しない）
      if (!handled && newName && newName !== prevOldName) {
        guessReadingWithKuromoji(newName).then(guessed => {
          if (guessed !== null && getName() === newName) setKana(guessed);
        });
      }
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
      const newName = e.currentTarget.value;
      const prevOldName = nameAtFocusStart;
      const handled = applyNameEditToKana(prevOldName, newName, '', getKana(), setKana);
      nameAtFocusStart = newName;
      if (!handled && newName && newName !== prevOldName) {
        guessReadingWithKuromoji(newName).then(guessed => {
          if (guessed !== null && getName() === newName) setKana(guessed);
        });
      }
    },
  });

  // 🚨 下書きのキーパーソン①②を更新
  const handleDraftKeyPersonChange = (keyPersonId: string, field: keyof KeyPerson, value: string) => {
    setSummaryDraft(prev => {
      if (!prev) return prev;
      const nextKeyPersons = prev.summary.keyPersons.map(kp => kp.id === keyPersonId ? { ...kp, [field]: value } : kp);
      return { ...prev, summary: { ...prev.summary, keyPersons: nextKeyPersons } };
    });
  };

  // 🏠 キーパーソンの郵便番号欄への数字入力を処理する。7桁揃ったら郵便番号検索APIを呼び、住所欄が空ならそこまで自動入力する
  // 🏠 郵便番号欄への数字入力を処理する共通ロジック。7桁揃ったら検索し、結果を`applyAddress`で下書きへ反映する
  const runPostalCodeLookup = (statusKey: string, digits: string, applyAddress: (address: string) => void) => {
    if (digits.length !== 7) {
      setPostalLookupStatus(prev => ({ ...prev, [statusKey]: undefined }));
      return;
    }
    setPostalLookupStatus(prev => ({ ...prev, [statusKey]: 'loading' }));
    lookupAddressByPostalCode(digits).then(address => {
      setPostalLookupStatus(prev => ({ ...prev, [statusKey]: address ? undefined : 'error' }));
      if (!address) return;
      applyAddress(address);
    });
  };

  const handleKeyPersonPostalCodeChange = (keyPersonId: string, rawValue: string) => {
    const digits = rawValue.replace(/[^0-9]/g, '').slice(0, 7);
    handleDraftKeyPersonChange(keyPersonId, 'postalCode', digits);
    runPostalCodeLookup(keyPersonId, digits, address => {
      setSummaryDraft(prev => {
        if (!prev) return prev;
        const kp = prev.summary.keyPersons.find(x => x.id === keyPersonId);
        // ℹ️ 郵便番号が変わらないうちに他の操作で下書きが更新されている場合のみ、反映せず取りこぼす
        if (!kp || kp.postalCode !== digits) return prev;
        const nextKeyPersons = prev.summary.keyPersons.map(x => x.id === keyPersonId ? { ...x, address } : x);
        return { ...prev, summary: { ...prev.summary, keyPersons: nextKeyPersons } };
      });
    });
  };

  // 🏠 救急搬送希望先の郵便番号欄への数字入力を処理する。7桁揃ったら住所欄へ都道府県～市区町村まで自動入力する
  const handleEmergencyHospitalPostalCodeChange = (rawValue: string) => {
    const digits = rawValue.replace(/[^0-9]/g, '').slice(0, 7);
    handleDraftSummaryChange('emergencyHospitalPostalCode', digits);
    runPostalCodeLookup('emergencyHospital', digits, address => {
      setSummaryDraft(prev => {
        if (!prev) return prev;
        // ℹ️ 郵便番号が変わらないうちに他の操作で下書きが更新されている場合のみ、反映せず取りこぼす
        if (prev.summary.emergencyHospitalPostalCode !== digits) return prev;
        return { ...prev, summary: { ...prev.summary, emergencyHospitalAddress: address } };
      });
    });
  };

  // 🏠 かかりつけ医の郵便番号欄への数字入力を処理する。7桁揃ったら住所欄へ都道府県～市区町村まで自動入力する
  const handlePrimaryDoctorPostalCodeChange = (rawValue: string) => {
    const digits = rawValue.replace(/[^0-9]/g, '').slice(0, 7);
    handleDraftSummaryChange('primaryDoctorPostalCode', digits);
    runPostalCodeLookup('primaryDoctor', digits, address => {
      setSummaryDraft(prev => {
        if (!prev) return prev;
        // ℹ️ 郵便番号が変わらないうちに他の操作で下書きが更新されている場合のみ、反映せず取りこぼす
        if (prev.summary.primaryDoctorPostalCode !== digits) return prev;
        return { ...prev, summary: { ...prev.summary, primaryDoctorAddress: address } };
      });
    });
  };
  // 🏠 かかりつけ医の履歴一覧「その場編集」欄・「新規追加」欄の郵便番号にも、同じく自動住所入力を効かせる
  const handlePrimaryDoctorHistoryEditPostalCodeChange = (rawValue: string) => {
    const digits = rawValue.replace(/[^0-9]/g, '').slice(0, 7);
    setPrimaryDoctorHistoryEditDraft(prev => ({ ...prev, postalCode: digits }));
    runPostalCodeLookup('primaryDoctorHistoryEdit', digits, address => {
      setPrimaryDoctorHistoryEditDraft(prev => (prev.postalCode !== digits ? prev : { ...prev, address }));
    });
  };
  const handleNewPrimaryDoctorEntryPostalCodeChange = (rawValue: string) => {
    const digits = rawValue.replace(/[^0-9]/g, '').slice(0, 7);
    setNewPrimaryDoctorEntryDraft(prev => ({ ...prev, postalCode: digits }));
    runPostalCodeLookup('newPrimaryDoctorEntry', digits, address => {
      setNewPrimaryDoctorEntryDraft(prev => (prev.postalCode !== digits ? prev : { ...prev, address }));
    });
  };
  // 🚑 救急搬送希望先の履歴一覧「その場編集」欄・「新規追加」欄の郵便番号にも、同じく自動住所入力を効かせる
  const handleEmergencyHospitalHistoryEditPostalCodeChange = (rawValue: string) => {
    const digits = rawValue.replace(/[^0-9]/g, '').slice(0, 7);
    setEmergencyHospitalHistoryEditDraft(prev => ({ ...prev, postalCode: digits }));
    runPostalCodeLookup('emergencyHospitalHistoryEdit', digits, address => {
      setEmergencyHospitalHistoryEditDraft(prev => (prev.postalCode !== digits ? prev : { ...prev, address }));
    });
  };
  const handleNewEmergencyHospitalEntryPostalCodeChange = (rawValue: string) => {
    const digits = rawValue.replace(/[^0-9]/g, '').slice(0, 7);
    setNewEmergencyHospitalEntryDraft(prev => ({ ...prev, postalCode: digits }));
    runPostalCodeLookup('newEmergencyHospitalEntry', digits, address => {
      setNewEmergencyHospitalEntryDraft(prev => (prev.postalCode !== digits ? prev : { ...prev, address }));
    });
  };

  // 🚨 下書きの内服薬を更新・追加・削除
  const handleDraftMedicationChange = (medId: string, field: keyof MedicationDetail, value: string) => {
    setSummaryDraft(prev => {
      if (!prev) return prev;
      const nextMeds = prev.summary.medications.map(m => m.id === medId ? { ...m, [field]: value } : m);
      return { ...prev, summary: { ...prev.summary, medications: nextMeds } };
    });
  };
  const handleDraftAddMedication = () => {
    setSummaryDraft(prev => {
      if (!prev) return prev;
      const nextMeds = [...prev.summary.medications, { id: `m_${Date.now()}`, name: '', dosageTiming: '' }];
      return { ...prev, summary: { ...prev.summary, medications: nextMeds } };
    });
  };
  const handleDraftRemoveMedication = (medId: string) => {
    setSummaryDraft(prev => {
      if (!prev) return prev;
      const nextMeds = prev.summary.medications.filter(m => m.id !== medId);
      return { ...prev, summary: { ...prev.summary, medications: nextMeds } };
    });
  };
  // 💊 内服薬の薬剤名欄からフォーカスが外れたら、その行の薬剤名・用法の組み合わせを履歴として保存する
  // （次回以降、薬剤名欄をクリックするとあいうえお順の一覧から選び直せる。初回は履歴が空）
  const handleMedicationNameBlur = (medId: string) => {
    if (typeof window === 'undefined' || !summaryDraft) return;
    const med = summaryDraft.summary.medications.find(m => m.id === medId);
    if (!med) return;
    const name = med.name.trim();
    const dosageTiming = med.dosageTiming.trim();
    if (!name) return;
    const alreadySaved = medicationHistory.some(h => h.name === name && h.dosageTiming === dosageTiming);
    if (alreadySaved) return;
    const nextHistory = [{ name, dosageTiming }, ...medicationHistory];
    setMedicationHistory(nextHistory);
    localStorage.setItem('oncall_medication_history', JSON.stringify(nextHistory));
  };
  const handleSelectMedicationHistory = (medId: string, entry: { name: string; dosageTiming: string }) => {
    handleDraftMedicationChange(medId, 'name', entry.name);
    handleDraftMedicationChange(medId, 'dosageTiming', entry.dosageTiming);
    setOpenMedicationHistoryId(null);
  };
  // ✏️ 内服薬の履歴一覧から、不要になった1件だけを削除する
  const handleDeleteMedicationHistory = (entry: { name: string; dosageTiming: string }) => {
    const nextHistory = medicationHistory.filter(h => !(h.name === entry.name && h.dosageTiming === entry.dosageTiming));
    setMedicationHistory(nextHistory);
    if (typeof window !== 'undefined') {
      localStorage.setItem('oncall_medication_history', JSON.stringify(nextHistory));
    }
  };

  // 🚨 下書きの禁忌薬（絶対に避ける薬剤）を更新・追加・削除
  const handleDraftContraindicatedMedicationChange = (cmId: string, value: string) => {
    setSummaryDraft(prev => {
      if (!prev) return prev;
      const nextList = prev.summary.contraindicatedMedications.map(cm => cm.id === cmId ? { ...cm, name: value } : cm);
      return { ...prev, summary: { ...prev.summary, contraindicatedMedications: nextList } };
    });
  };
  const handleDraftAddContraindicatedMedication = () => {
    setSummaryDraft(prev => {
      if (!prev) return prev;
      const nextList = [...prev.summary.contraindicatedMedications, { id: `cm_${Date.now()}`, name: '' }];
      return { ...prev, summary: { ...prev.summary, contraindicatedMedications: nextList } };
    });
  };
  const handleDraftRemoveContraindicatedMedication = (cmId: string) => {
    setSummaryDraft(prev => {
      if (!prev) return prev;
      const nextList = prev.summary.contraindicatedMedications.filter(cm => cm.id !== cmId);
      return { ...prev, summary: { ...prev.summary, contraindicatedMedications: nextList } };
    });
  };
  // 💊 禁忌薬の欄からフォーカスが外れたら、その薬剤名を履歴として保存する
  // （次回以降、禁忌薬欄をクリックするとあいうえお順の一覧から選び直せる。初回は履歴が空）
  const handleContraindicatedNameBlur = (cmId: string) => {
    if (typeof window === 'undefined' || !summaryDraft) return;
    const cm = summaryDraft.summary.contraindicatedMedications.find(c => c.id === cmId);
    if (!cm) return;
    const name = cm.name.trim();
    if (!name || contraindicatedMedicationHistory.includes(name)) return;
    const nextHistory = [name, ...contraindicatedMedicationHistory];
    setContraindicatedMedicationHistory(nextHistory);
    localStorage.setItem('oncall_contraindicated_medication_history', JSON.stringify(nextHistory));
  };
  const handleSelectContraindicatedHistory = (cmId: string, name: string) => {
    handleDraftContraindicatedMedicationChange(cmId, name);
    setOpenContraindicatedHistoryId(null);
  };
  // ✏️ 禁忌薬の履歴一覧から、不要になった1件だけを削除する
  const handleDeleteContraindicatedHistory = (name: string) => {
    const nextHistory = contraindicatedMedicationHistory.filter(h => h !== name);
    setContraindicatedMedicationHistory(nextHistory);
    if (typeof window !== 'undefined') {
      localStorage.setItem('oncall_contraindicated_medication_history', JSON.stringify(nextHistory));
    }
  };
  // 🚨 下書きの感染症有無を更新・追加・削除（禁忌薬と同じく、1項目＝1欄のリスト形式）
  const handleDraftInfectionItemChange = (itemId: string, value: string) => {
    setSummaryDraft(prev => {
      if (!prev) return prev;
      const nextList = prev.summary.infectionStatusItems.map(it => it.id === itemId ? { ...it, text: value } : it);
      return { ...prev, summary: { ...prev.summary, infectionStatusItems: nextList } };
    });
  };
  const handleDraftAddInfectionItem = () => {
    setSummaryDraft(prev => {
      if (!prev) return prev;
      const nextList = [...prev.summary.infectionStatusItems, { id: `is_${Date.now()}`, text: '' }];
      return { ...prev, summary: { ...prev.summary, infectionStatusItems: nextList } };
    });
  };
  const handleDraftRemoveInfectionItem = (itemId: string) => {
    setSummaryDraft(prev => {
      if (!prev) return prev;
      const nextList = prev.summary.infectionStatusItems.filter(it => it.id !== itemId);
      return { ...prev, summary: { ...prev.summary, infectionStatusItems: nextList } };
    });
  };
  // 💊 感染症有無の欄からフォーカスが外れたら、その内容を履歴として保存する
  // （次回以降、感染症有無欄をクリックするとあいうえお順の一覧から選び直せる。初回は履歴が空）
  const handleInfectionItemBlur = (itemId: string) => {
    if (typeof window === 'undefined' || !summaryDraft) return;
    const item = summaryDraft.summary.infectionStatusItems.find(it => it.id === itemId);
    if (!item) return;
    const text = item.text.trim();
    if (!text || infectionStatusHistory.includes(text)) return;
    const nextHistory = [text, ...infectionStatusHistory];
    setInfectionStatusHistory(nextHistory);
    localStorage.setItem('oncall_infection_status_history', JSON.stringify(nextHistory));
  };
  const handleSelectInfectionHistory = (itemId: string, text: string) => {
    handleDraftInfectionItemChange(itemId, text);
    setOpenInfectionHistoryId(null);
  };
  // ✏️ 感染症有無の履歴一覧から、不要になった1件だけを削除する
  const handleDeleteInfectionHistory = (text: string) => {
    const nextHistory = infectionStatusHistory.filter(h => h !== text);
    setInfectionStatusHistory(nextHistory);
    if (typeof window !== 'undefined') {
      localStorage.setItem('oncall_infection_status_history', JSON.stringify(nextHistory));
    }
  };

  // 🔒 フロアMapのレ点：いずれか1つをクリックすると、その入居者1人分の項目一覧を開く（1件ずつパスワードを
  //    聞かれる手間を無くすため、パスワード確認は保存時に1回だけ行う）。下書きは現在の値で初期化する
  const handleOpenMapCheckboxEditor = (patientId: string) => {
    const p = patients.find(pt => pt.id === patientId);
    if (!p) return;
    const draft = {} as Record<MapCheckboxFieldKey, boolean>;
    MAP_CHECKBOX_FIELDS.forEach(f => { draft[f.key] = p[f.key]; });
    setMapCheckboxDraft(draft);
    setMapCheckboxEditorPatientId(patientId);
  };

  // 🔒 レ点編集画面の「保存する」：ここで1回だけ管理者パスワードを確認し、変更があればその入居者だけ実データへ反映する
  const handleSaveMapCheckboxEditor = () => {
    const patientId = mapCheckboxEditorPatientId;
    if (!patientId) return;
    const MASTER_PASSWORD = 'master999';
    const inputPassword = prompt('⚠️ 意思決定・緊急時対応の変更には管理者パスワードが必要です。\nパスワードを入力してください：');
    if (inputPassword === null) return;
    if (inputPassword !== MASTER_PASSWORD) {
      alert('❌ パスワードが正しくありません。変更は破棄されました。');
      return;
    }
    setPatients(prev => prev.map(p => {
      if (p.id !== patientId) return p;
      const changed = MAP_CHECKBOX_FIELDS.some(f => p[f.key] !== mapCheckboxDraft[f.key]);
      if (!changed) return p;
      return touchLastEdited({ ...p, ...mapCheckboxDraft });
    }));
    setMapCheckboxEditorPatientId(null);
  };

  // ✍️ 医師指示メモを更新すると同時に、キーワードから③指示内容の候補を自動抽出して未チェックの行として追加する
  const handleDoctorMemoChange = (patientId: string, memoText: string) => {
    setPatients(prev => prev.map(p => {
      if (p.id !== patientId) return p;

      const suggestions = getSuggestedInstructions(memoText);
      const existingLines = p.doctorOrder.split('\n').map(l => l.trim()).filter(l => l !== '');
      // すでに指示内容にある候補や、看護師が一度消去した候補は再追加しない
      const linesToAdd = suggestions.filter(s => !existingLines.includes(s) && !p.dismissedSuggestions.includes(s));

      if (linesToAdd.length === 0) {
        return touchLastEdited(syncObservationSuggestions({ ...p, doctorMemo: memoText }));
      }

      const currentOrder = p.doctorOrder.trim();
      const currentLineCount = currentOrder ? currentOrder.split('\n').length : 0;
      const nextOrder = currentOrder ? `${currentOrder}\n${linesToAdd.join('\n')}` : linesToAdd.join('\n');

      // ✏️ 自動追加された行にも、記載者（ログイン中のユーザー）と期間（開始日=今日）を記録する
      const nextCreatedBy = { ...p.orderCreatedBy };
      const nextPeriods = { ...p.orderPeriods };
      const todayIso = getTodayISO();
      linesToAdd.forEach((_, i) => {
        nextCreatedBy[currentLineCount + i] = loggedInUser || '不明なユーザー';
        nextPeriods[currentLineCount + i] = { startDate: todayIso, durationDays: null };
      });

      return touchLastEdited(syncObservationSuggestions({ ...p, doctorMemo: memoText, doctorOrder: nextOrder, orderCreatedBy: nextCreatedBy, orderPeriods: nextPeriods }));
    }));
  };

  // 🗑️ 重要オーダーの1行を削除する関数（サイン情報のインデックスもずれないよう再構築する）
  const handleDeleteOrderLine = (patientId: string, lineIndex: number) => {
    setPatients(prev => prev.map(p => {
      if (p.id !== patientId) return p;

      const lines = p.doctorOrder.split('\n');
      if (lineIndex < 0 || lineIndex >= lines.length) return p;

      const confirmDelete = window.confirm(`「${lines[lineIndex]}」を削除しますか？\n※この操作は取り消せません。`);
      if (!confirmDelete) return p;

      const removedText = lines[lineIndex].trim();
      const newLines = lines.filter((_, idx) => idx !== lineIndex);

      // orderStatusのインデックスを、削除した行より後ろのものだけ1つずつ前に詰める
      const newStatus: Patient['orderStatus'] = {};
      Object.keys(p.orderStatus).forEach((key) => {
        const idx = parseInt(key, 10);
        if (idx < lineIndex) {
          newStatus[idx] = p.orderStatus[idx];
        } else if (idx > lineIndex) {
          newStatus[idx - 1] = p.orderStatus[idx];
        }
        // idx === lineIndex の場合は削除対象なので何もしない
      });

      // orderCreatedByも同様にインデックスを詰める
      const newCreatedBy: Patient['orderCreatedBy'] = {};
      Object.keys(p.orderCreatedBy).forEach((key) => {
        const idx = parseInt(key, 10);
        if (idx < lineIndex) {
          newCreatedBy[idx] = p.orderCreatedBy[idx];
        } else if (idx > lineIndex) {
          newCreatedBy[idx - 1] = p.orderCreatedBy[idx];
        }
      });

      // orderPeriodsも同様にインデックスを詰める
      const newPeriods: Patient['orderPeriods'] = {};
      Object.keys(p.orderPeriods).forEach((key) => {
        const idx = parseInt(key, 10);
        if (idx < lineIndex) {
          newPeriods[idx] = p.orderPeriods[idx];
        } else if (idx > lineIndex) {
          newPeriods[idx - 1] = p.orderPeriods[idx];
        }
      });

      // 削除したのが自動候補の項目であれば、同じ医師指示メモのままでも再提示されないよう記録する
      const nextDismissed = (INSTRUCTION_SUGGESTION_ORDER.includes(removedText) && !p.dismissedSuggestions.includes(removedText))
        ? [...p.dismissedSuggestions, removedText]
        : p.dismissedSuggestions;

      logAction(p.room, p.name, '削除', removedText);

      return touchLastEdited(syncObservationSuggestions({ ...p, doctorOrder: newLines.join('\n'), orderStatus: newStatus, orderCreatedBy: newCreatedBy, orderPeriods: newPeriods, dismissedSuggestions: nextDismissed }));
    }));
  };

  // 🔒 オーダーをチェックする際、ID/PWを入力して「誰がいつ」処理したか特定する
  const handleToggleOrderLine = (patientId: string, lineIndex: number) => {
    setPatients(prev => prev.map(p => {
      if (p.id === patientId) {
        const nextStatus = { ...p.orderStatus };
        const currentItem = nextStatus[lineIndex] || { checked: false };
        const lineText = (p.doctorOrder.split('\n')[lineIndex] || '').trim();

        if (!currentItem.checked) {
          // レ点を入れる時：ID/パスワードの再確認は行わず、ログイン中のユーザーで自動記録する
          const now = new Date();
          const timeStr = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          nextStatus[lineIndex] = {
            checked: true,
            Sign: `${timeStr} ${loggedInUser || '不明なユーザー'}`
          };
          logAction(p.room, p.name, 'チェック実施', lineText);
        } else {
          // レ点を外す時
          const confirmUncheck = window.confirm('取り消しますか？サイン情報もクリアされます。');
          if (!confirmUncheck) return p;
          nextStatus[lineIndex] = { checked: false };
          logAction(p.room, p.name, 'チェック取消', lineText);
        }

        return touchLastEdited({ ...p, orderStatus: nextStatus });
      }
      return p;
    }));
  };

  // ✍️ ③指示内容を手動で1件追加する（自動候補と同じ入力欄に統一したことで、重複した自由記述欄を廃止）
  const [manualOrderInput, setManualOrderInput] = useState<{ [patientId: string]: string }>({});
  const handleManualAddOrderLine = (patientId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    let addedLineIndex = -1;
    setPatients(prev => prev.map(p => {
      if (p.id !== patientId) return p;
      const currentOrder = p.doctorOrder.trim();
      const newLineIndex = currentOrder ? currentOrder.split('\n').length : 0;
      addedLineIndex = newLineIndex;
      const nextOrder = currentOrder ? `${currentOrder}\n${trimmed}` : trimmed;
      logAction(p.room, p.name, '手動追加', trimmed);
      // ✏️ この行を記載した人（ログイン中のユーザー）と期間（開始日=今日）を記録する
      const nextCreatedBy = { ...p.orderCreatedBy, [newLineIndex]: loggedInUser || '不明なユーザー' };
      const nextPeriods = { ...p.orderPeriods, [newLineIndex]: { startDate: getTodayISO(), durationDays: null } };
      return touchLastEdited(syncObservationSuggestions({ ...p, doctorOrder: nextOrder, orderCreatedBy: nextCreatedBy, orderPeriods: nextPeriods }));
    }));
    // 🗓️ 指示を追加したら、続けて期間（開始日・日数）を選べるよう自動でパネルを開く
    if (addedLineIndex >= 0) {
      handleOpenPeriodEditor(patientId, addedLineIndex, getTodayISO());
    }
  };

  // ✏️ ③指示内容の行をダブルクリックで編集する（編集者は自動的にログイン中のユーザーで上書き記録される）
  const [editingLine, setEditingLine] = useState<{ patientId: string; lineIndex: number } | null>(null);
  const [editingLineText, setEditingLineText] = useState('');

  const handleStartEditOrderLine = (patientId: string, lineIndex: number, currentText: string) => {
    setEditingLine({ patientId, lineIndex });
    setEditingLineText(currentText);
  };

  const handleCommitEditOrderLine = () => {
    if (!editingLine) return;
    const { patientId, lineIndex } = editingLine;
    const trimmed = editingLineText.trim();

    if (!trimmed) {
      // 空欄にして確定した場合は変更せずキャンセル扱いにする
      setEditingLine(null);
      return;
    }

    setPatients(prev => prev.map(p => {
      if (p.id !== patientId) return p;
      const lines = p.doctorOrder.split('\n');
      if (lineIndex < 0 || lineIndex >= lines.length) return p;
      if (lines[lineIndex] === trimmed) return p; // 変更なし

      lines[lineIndex] = trimmed;
      logAction(p.room, p.name, '編集', trimmed);
      // ✏️ 編集した人（ログイン中のユーザー）で記載者を上書きする
      const nextCreatedBy = { ...p.orderCreatedBy, [lineIndex]: loggedInUser || '不明なユーザー' };
      return touchLastEdited(syncObservationSuggestions({ ...p, doctorOrder: lines.join('\n'), orderCreatedBy: nextCreatedBy }));
    }));

    setEditingLine(null);
  };

  // 🗓️ ③各行の期間（開始日・日数）を編集する
  // 開始日はここ（軽量なローカル状態）だけで管理し、患者一覧全体（重いデータ）への書き込みは
  // 日数ボタンを押した「最後の1回」だけにまとめる。
  // ⚠️ <input type="date">のカレンダー部品はブラウザ環境によってReactのonChangeが発火しない
  // 場合があることが判明したため、確実に動作する「ボタンだけ」で開始日を選ぶ方式にしている。
  const [editingPeriod, setEditingPeriod] = useState<{ patientId: string; lineIndex: number; draftStartDate: string; draftDurationDays: number | null } | null>(null);
  // 🗓️ 開始日を選ぶカレンダーが現在表示している月（YYYY-MM）。開始日そのものとは別に、月だけ移動できる
  const [periodStartCalendarMonth, setPeriodStartCalendarMonth] = useState<string>('');

  const handleOpenPeriodEditor = (patientId: string, lineIndex: number, currentStartDate: string, currentDurationDays?: number | null) => {
    const initialIso = currentStartDate || getTodayISO();
    // 🔒 すでに登録されている開始日が往診日より前だった場合、開いた時点で往診日に補正する
    const visitIso = parseJapaneseDateToISO(nextVisitDate);
    const clampedIso = (visitIso && initialIso < visitIso) ? visitIso : initialIso;
    const initialDuration = currentDurationDays ?? null;
    setEditingPeriod({ patientId, lineIndex, draftStartDate: clampedIso, draftDurationDays: initialDuration });
    // 下部の「終了日」表示も、現在保存されている期間と同じ値から開始する
    setDraftEndDate(getOrderEndDateISO(clampedIso, initialDuration) || clampedIso);
    setIsEndDateMode(false);
    setPeriodStartCalendarMonth(clampedIso.slice(0, 7));
  };

  // 🗓️ 開始日カレンダーの表示月を前後に1ヶ月ずつ移動する
  const shiftPeriodStartCalendarMonth = (deltaMonths: number) => {
    setPeriodStartCalendarMonth(prev => {
      const [y, m] = (prev || getTodayISO().slice(0, 7)).split('-').map(Number);
      const d = new Date(y, m - 1 + deltaMonths, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });
  };

  // 🗓️ カレンダーの日付をクリックして、開始日を直接選ぶ（診療日より前の日付は選べない）
  const handleSelectPeriodStartDate = (iso: string) => {
    if (!editingPeriod) return;
    const visitIso = parseJapaneseDateToISO(nextVisitDate);
    const finalIso = (visitIso && iso < visitIso) ? visitIso : iso;
    const nextEnd = getOrderEndDateISO(finalIso, editingPeriod.draftDurationDays);
    setDraftEndDate(nextEnd || finalIso);
    setEditingPeriod(prev => (prev ? { ...prev, draftStartDate: finalIso } : prev));
  };

  // 📌 開始日をボタンで1日ずつ進める・戻す（ローカルの下書きだけを更新。患者一覧全体はまだ書き換えない・軽量）
  // 🔒 往診日より前の日付には移動できないようブロックする
  const shiftPeriodDraftDate = (deltaDays: number) => {
    if (!editingPeriod) return;
    const base = editingPeriod.draftStartDate || getTodayISO();
    const d = new Date(base + 'T00:00:00');
    d.setDate(d.getDate() + deltaDays);
    let nextIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    // 🔒 往診日より前の日付は選べない（自動的に往診日でストップする）
    const visitIso = parseJapaneseDateToISO(nextVisitDate);
    if (visitIso && nextIso < visitIso) nextIso = visitIso;
    if (editingPeriod.draftStartDate === nextIso) return;

    // 開始日変更と同時に、下部の終了日も現在の日数に合わせて即時更新する
    const nextEnd = getOrderEndDateISO(nextIso, editingPeriod.draftDurationDays);
    setDraftEndDate(nextEnd || nextIso);
    setEditingPeriod(prev => (prev ? { ...prev, draftStartDate: nextIso } : prev));
    setPeriodStartCalendarMonth(nextIso.slice(0, 7));
  };

  // 📌 開始日を「今日」にワンタップで戻す（往診日より前になる場合は往診日にする）
  const setPeriodDraftDateToToday = () => {
    if (!editingPeriod) return;
    const todayIso = getTodayISO();
    const visitIso = parseJapaneseDateToISO(nextVisitDate);
    const finalIso = (visitIso && todayIso < visitIso) ? visitIso : todayIso;
    setPeriodStartCalendarMonth(finalIso.slice(0, 7));
    const nextEnd = getOrderEndDateISO(finalIso, editingPeriod.draftDurationDays);
    setDraftEndDate(nextEnd || finalIso);
    setEditingPeriod(prev => (prev ? { ...prev, draftStartDate: finalIso } : prev));
  };

  // 🗓️ 終了日を手動で選ぶモード（プリセット日数を使わず、開始日・終了日を両方ボタンで指定したい時に使う）
  const [isEndDateMode, setIsEndDateMode] = useState(false);
  const [draftEndDate, setDraftEndDate] = useState<string>('');

  const openEndDateMode = () => {
    if (!editingPeriod) return;
    // すでに日数が選ばれている場合は、その終了日を初期値として引き継ぐ
    const currentEnd = getOrderEndDateISO(editingPeriod.draftStartDate, editingPeriod.draftDurationDays);
    setDraftEndDate(currentEnd || editingPeriod.draftStartDate || getTodayISO());
    setIsEndDateMode(true);
  };

  const closeEndDateMode = () => {
    setIsEndDateMode(false);
  };

  // 📌 終了日をボタンで1日ずつ進める・戻す（開始日より前にはならないようブロックする）
  const shiftDraftEndDate = (deltaDays: number) => {
    if (!editingPeriod) return;
    setDraftEndDate(prev => {
      const base = prev || editingPeriod.draftStartDate || getTodayISO();
      const d = new Date(base + 'T00:00:00');
      d.setDate(d.getDate() + deltaDays);
      const nextIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

      // 🔒 開始日より前の終了日にはならないようにする
      if (nextIso < editingPeriod.draftStartDate) return editingPeriod.draftStartDate;
      return nextIso;
    });
  };

  // 💾 手動終了日モードも、最後は同じ「保存する」で④へ確定する
  const handleSaveManualEndDate = () => {
    if (!editingPeriod || !draftEndDate) return;
    const { patientId, lineIndex, draftStartDate } = editingPeriod;

    const start = new Date(draftStartDate + 'T00:00:00');
    const end = new Date(draftEndDate + 'T00:00:00');
    const diffDays = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    const finalDays = diffDays >= 1 ? diffDays : 1;

    setPatients(prev => prev.map(p => {
      if (p.id !== patientId) return p;
      const current = p.orderPeriods[lineIndex] || { startDate: draftStartDate, durationDays: null };
      return touchLastEdited({
        ...p,
        orderPeriods: {
          ...p.orderPeriods,
          [lineIndex]: { ...current, startDate: draftStartDate, durationDays: finalDays, endDate: draftEndDate, manualText: undefined },
        },
      });
    }));

    setIsEndDateMode(false);
    setEditingPeriod(null);
  };

  // 📌 日数ボタンをクリック：開始日から終了日を計算し、下部表示にも即時反映する（まだ保存しない）
  const handleSelectPeriodDuration = (days: number) => {
    if (!editingPeriod) return;
    // 📌 setEditingPeriodの更新関数の「中」でsetDraftEndDateを呼ぶと、
    // タイミングによって計算がズレることがあるため、先に値を計算してから順番に確定させる
    const endIso = getOrderEndDateISO(editingPeriod.draftStartDate, days);
    setDraftEndDate(endIso || editingPeriod.draftStartDate);
    setEditingPeriod(prev => (prev ? { ...prev, draftDurationDays: days } : prev));
  };

  // 💾 「保存する」ボタン：下書きの開始日＋日数を確定し、③④に反映してモーダルを閉じる
  const handleSavePeriod = () => {
    if (!editingPeriod) return;
    const { patientId, lineIndex, draftStartDate, draftDurationDays } = editingPeriod;
    const finalStartDate = draftStartDate || getTodayISO();
    const finalEndDate = getOrderEndDateISO(finalStartDate, draftDurationDays);

    // ✅ 保存ボタンが押されることは確認済みのため、デバッグ用アラートは削除しました

    setPatients(prev => prev.map(p => {
      if (p.id !== patientId) return p;
      const current = p.orderPeriods[lineIndex] || { startDate: finalStartDate, durationDays: null };

      // ★ 設定画面で見えている開始日・終了日を、そのまま④用データへ保存する。
      return touchLastEdited({
        ...p,
        orderPeriods: {
          ...p.orderPeriods,
          [lineIndex]: {
            ...current,
            startDate: finalStartDate,
            durationDays: draftDurationDays,
            endDate: finalEndDate || finalStartDate,
            manualText: undefined,
          },
        },
      });
    }));

    setIsEndDateMode(false);
    setEditingPeriod(null);
  };

  // 🗓️ ④期間の表示部分をダブルクリックすると、期間を自由記述で手動編集できる（保存すると一覧表示に戻る）
  const [editingPeriodText, setEditingPeriodText] = useState<{ patientId: string; lineIndex: number } | null>(null);
  const [editingPeriodTextValue, setEditingPeriodTextValue] = useState('');

  const handleStartEditPeriodText = (patientId: string, lineIndex: number, currentText: string) => {
    setEditingPeriod(null); // 開始日・日数の編集パネルが開いていれば閉じる
    setEditingPeriodText({ patientId, lineIndex });
    setEditingPeriodTextValue(currentText === '未設定' ? '' : currentText);
  };

  const handleCommitEditPeriodText = () => {
    if (!editingPeriodText) return;
    const { patientId, lineIndex } = editingPeriodText;
    const trimmed = editingPeriodTextValue.trim();

    setPatients(prev => prev.map(p => {
      if (p.id !== patientId) return p;
      const current = p.orderPeriods[lineIndex] || { startDate: '', durationDays: null };
      return touchLastEdited({ ...p, orderPeriods: { ...p.orderPeriods, [lineIndex]: { ...current, manualText: trimmed || undefined } } });
    }));

    setEditingPeriodText(null);
  };

  // 👁️ 観察要点：不要な項目を削除する（再提示されないよう記録する）
  // パスワードは求めない（頓用薬と同様、画面右上の「保存」操作をこの画面の確定操作として扱う）
  const handleDeleteObservationLine = (patientId: string, lineIndex: number) => {
    setPatients(prev => prev.map(p => {
      if (p.id !== patientId) return p;
      const lines = p.observationList.split('\n');
      if (lineIndex < 0 || lineIndex >= lines.length) return p;

      const removedText = lines[lineIndex].trim();
      const newLines = lines.filter((_, idx) => idx !== lineIndex);

      const newStatus: Patient['observationStatus'] = {};
      Object.keys(p.observationStatus).forEach((key) => {
        const idx = parseInt(key, 10);
        if (idx < lineIndex) newStatus[idx] = p.observationStatus[idx];
        else if (idx > lineIndex) newStatus[idx - 1] = p.observationStatus[idx];
      });

      const nextDismissed = (OBSERVATION_SUGGESTION_ORDER.includes(removedText) && !p.dismissedObservations.includes(removedText))
        ? [...p.dismissedObservations, removedText]
        : p.dismissedObservations;

      return touchLastEdited({ ...p, observationList: newLines.join('\n'), observationStatus: newStatus, dismissedObservations: nextDismissed });
    }));
  };

  // 👁️ 観察要点：手動で1件追加する
  const [manualObservationInput, setManualObservationInput] = useState<{ [patientId: string]: string }>({});
  const handleManualAddObservationLine = (patientId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPatients(prev => prev.map(p => {
      if (p.id !== patientId) return p;
      const currentList = p.observationList.trim();
      const nextList = currentList ? `${currentList}\n${trimmed}` : trimmed;
      return touchLastEdited({ ...p, observationList: nextList });
    }));
  };

  // ✏️ 観察要点：追加済みの項目をダブルクリックで書き直せるようにする（パスワード不要・空欄で確定しても元の文言は消えない）
  const [editingObservationLine, setEditingObservationLine] = useState<{ patientId: string; lineIndex: number } | null>(null);
  const [editingObservationText, setEditingObservationText] = useState('');

  const handleStartEditObservationLine = (patientId: string, lineIndex: number, currentText: string) => {
    setEditingObservationLine({ patientId, lineIndex });
    setEditingObservationText(currentText);
  };

  const handleCommitEditObservationLine = () => {
    if (!editingObservationLine) return;
    const { patientId, lineIndex } = editingObservationLine;
    const trimmed = editingObservationText.trim();
    setEditingObservationLine(null);
    if (!trimmed) return;

    setPatients(prev => prev.map(p => {
      if (p.id !== patientId) return p;
      const lines = p.observationList.split('\n');
      if (lineIndex < 0 || lineIndex >= lines.length || lines[lineIndex] === trimmed) return p;
      const nextLines = [...lines];
      nextLines[lineIndex] = trimmed;
      return touchLastEdited({ ...p, observationList: nextLines.join('\n') });
    }));
  };

  // 👁️ 観察要点：消してしまった項目も含めて、②③の内容から自動抽出される初期状態に戻す
  const handleResetObservations = (patientId: string) => {
    const confirmReset = window.confirm('観察要点を初期状態に戻します。\n手動で追加した項目や、これまでのチェック状態も消えます。よろしいですか？');
    if (!confirmReset) return;

    setPatients(prev => prev.map(p => {
      if (p.id !== patientId) return p;
      const reset: Patient = { ...p, observationList: '', observationStatus: {}, dismissedObservations: [] };
      return touchLastEdited(syncObservationSuggestions(reset));
    }));
  };

  // 💊 頓用薬：普段は閉じていて、クリックすると開くパネルの開閉状態（患者ごと）
  const [openPrnPatientIds, setOpenPrnPatientIds] = useState<{ [patientId: string]: boolean }>({});

  // ➕ 頓用薬：「＋追加」を押した時だけ開く、候補一覧＋手動記載エリアの開閉状態（患者ごと）
  const [prnAddSectionOpenIds, setPrnAddSectionOpenIds] = useState<{ [patientId: string]: boolean }>({});
  const togglePrnAddSection = (patientId: string) => {
    setPrnAddSectionOpenIds(prev => ({ ...prev, [patientId]: !prev[patientId] }));
  };

  // 🌡️ 発熱時だけは複数選択できるようにする（他のグループは1つだけ選べるラジオボタン方式のまま）
  const PRN_MULTI_SELECT_GROUPS = ['発熱時（38.0以上）'];

  // 💊 頓用薬：パネルを開いている間だけの「下書き」選択状態（グループごとに選択中の項目ID一覧）
  // パスワードはここでは求めず、「保存する」を押した時に1回だけ確認する
  const [prnDraftSelections, setPrnDraftSelections] = useState<{ [patientId: string]: { [group: string]: string[] } }>({});

  // ✍️ 頓用薬：手動記載の下書き一覧＋入力中のカテゴリ名・テキスト（患者ごと）
  const [prnDraftManualEntries, setPrnDraftManualEntries] = useState<{ [patientId: string]: { id: string; group: string; text: string; addedBy: string; addedAt: string }[] }>({});
  const [manualPrnInput, setManualPrnInput] = useState<{ [patientId: string]: string }>({});
  const [manualPrnGroupInput, setManualPrnGroupInput] = useState<{ [patientId: string]: string }>({});

  // 🔀 頓用薬：選択済み項目の表示順の下書き（定型項目のid、または手動記載のidを並べた配列）
  const [prnDraftOrder, setPrnDraftOrder] = useState<{ [patientId: string]: string[] }>({});
  const [prnDragIndex, setPrnDragIndex] = useState<number | null>(null);

  // 💊 頓用薬「選択あり」表示：パネルを開いている間は下書きの状態を見て判定する（保存前でも「初期状態に戻す」等が
  // すぐバッジに反映されるように）。パネルを閉じている時は、これまで通り保存済みのpatientデータを見る
  const hasAnyPrnSelectedNow = (p: Patient): boolean => {
    if (!openPrnPatientIds[p.id]) return hasAnyPrnSelected(p);
    const draft = prnDraftSelections[p.id] || {};
    const anyPredefined = Object.values(draft).some(ids => ids.length > 0);
    const anyManual = (prnDraftManualEntries[p.id]?.length ?? 0) > 0;
    return anyPredefined || anyManual;
  };

  const togglePrnOpen = (patientId: string) => {
    const willOpen = !openPrnPatientIds[patientId];
    if (willOpen) {
      // 📌 パネルを開く時、今すでに選択されている内容を下書きの初期値としてコピーする
      const target = patients.find(p => p.id === patientId);
      const initialDraft: { [group: string]: string[] } = {};
      Array.from(new Set(PRN_MEDICATION_OPTIONS.map(opt => opt.group))).forEach(group => {
        const checkedOpts = PRN_MEDICATION_OPTIONS.filter(opt => opt.group === group && target?.prnMedications[opt.id]?.checked);
        initialDraft[group] = checkedOpts.map(opt => opt.id);
      });
      setPrnDraftSelections(prev => ({ ...prev, [patientId]: initialDraft }));
      const manualEntries = target?.prnManualEntries ? [...target.prnManualEntries] : [];
      setPrnDraftManualEntries(prev => ({ ...prev, [patientId]: manualEntries }));

      // 🔀 保存済みの並び順を復元。並び順に無い新しい項目があれば末尾に追加する
      const selectedPredefinedIds = Object.values(initialDraft).flat();
      const manualIds = manualEntries.map(m => m.id);
      const allCurrentIds = [...selectedPredefinedIds, ...manualIds];
      const savedOrder = (target?.prnSelectedOrder || []).filter(id => allCurrentIds.includes(id));
      const missingIds = allCurrentIds.filter(id => !savedOrder.includes(id));
      setPrnDraftOrder(prev => ({ ...prev, [patientId]: [...savedOrder, ...missingIds] }));
    } else {
      // 閉じる時は「＋追加」エリアも一緒に閉じておく
      setPrnAddSectionOpenIds(prev => ({ ...prev, [patientId]: false }));
    }
    setOpenPrnPatientIds(prev => ({ ...prev, [patientId]: willOpen }));
  };

  // 💊 頓用薬：パネル内で項目をクリック（下書きの選択を切り替えるだけ。パスワードは不要・まだ保存されない）
  // 発熱時グループは複数選択可（チェックボックス方式）、それ以外は1つだけ選べる（ラジオボタン方式）
  const handleToggleDraftPrn = (patientId: string, itemId: string) => {
    const targetOption = PRN_MEDICATION_OPTIONS.find(opt => opt.id === itemId);
    if (!targetOption) return;
    const isMultiSelectGroup = PRN_MULTI_SELECT_GROUPS.includes(targetOption.group);

    // ⚠️ setPrnDraftSelectionsの中でsetPrnDraftOrderを呼ぶと（setStateの中でsetStateを呼ぶ形になり）、
    // 開発モードの二重実行チェックで並び順に同じ項目が2回追加されてしまうため、先に必要な値をすべて
    // 計算してから、setPrnDraftSelectionsとsetPrnDraftOrderをそれぞれ独立に1回ずつ呼び出す
    const patientDraft = prnDraftSelections[patientId] || {};
    const currentIds = patientDraft[targetOption.group] || [];

    // 🚫 まだ選んでいない項目を新しく選ぼうとしている時、同じ文言の薬が別カテゴリで
    // すでに選ばれていたら（例：嘔気時／胃部不快で同じ薬を定義している場合）、
    // 一覧側でも隠しているが念のためここでも重複選択させない
    if (!currentIds.includes(itemId)) {
      const allSelectedIds = Object.values(patientDraft).flat();
      const alreadySelectedSameText = allSelectedIds.some(id => {
        const selectedOpt = PRN_MEDICATION_OPTIONS.find(o => o.id === id);
        return selectedOpt && selectedOpt.text === targetOption.text;
      });
      if (alreadySelectedSameText) return;
    }

    let nextIds: string[];
    let removedIds: string[] = [];

    if (isMultiSelectGroup) {
      // ✅ チェックボックス方式：押すたびに追加/解除を繰り返す（他の選択には影響しない）
      if (currentIds.includes(itemId)) {
        nextIds = currentIds.filter(id => id !== itemId);
        removedIds = [itemId];
      } else {
        nextIds = [...currentIds, itemId];
      }
    } else {
      // 🔘 ラジオボタン方式：同じものを押すと解除、違うものを押すと入れ替わる
      if (currentIds.includes(itemId)) {
        nextIds = [];
        removedIds = [itemId];
      } else {
        nextIds = [itemId];
        removedIds = currentIds; // 入れ替わりで外れた項目は並び順からも消す
      }
    }

    const isAdding = !currentIds.includes(itemId) && nextIds.includes(itemId);

    setPrnDraftSelections(prev => ({
      ...prev,
      [patientId]: { ...(prev[patientId] || {}), [targetOption.group]: nextIds },
    }));

    // 🔀 並び順も同時に更新：新しく選ばれたものは末尾に追加、外れたものは並び順から削除
    setPrnDraftOrder(prevOrder => {
      const currentOrder = (prevOrder[patientId] || []).filter(id => !removedIds.includes(id));
      const nextOrder = isAdding ? [...currentOrder, itemId] : currentOrder;
      return { ...prevOrder, [patientId]: nextOrder };
    });
  };

  // 💊 頓用薬：「未選択指示」の中の項目をまとめて全部選択する
  // （既存の一覧・グループ分けはそのまま。グループの1つだけ／複数選択の制限を無視して全部選ぶ）
  const handleSelectAllPrn = (patientId: string) => {
    const nextDraft: { [group: string]: string[] } = {};
    PRN_MEDICATION_OPTIONS.forEach(opt => {
      nextDraft[opt.group] = [...(nextDraft[opt.group] || []), opt.id];
    });
    setPrnDraftSelections(prev => ({ ...prev, [patientId]: nextDraft }));

    setPrnDraftOrder(prevOrder => {
      const manualIds = (prnDraftManualEntries[patientId] || []).map(e => e.id);
      const currentOrder = prevOrder[patientId] || [];
      const predefinedIds = PRN_MEDICATION_OPTIONS.map(opt => opt.id);
      // 🔀 すでに並び順に入っている項目はその位置を保ち、まだ入っていない定型項目だけ末尾に追加する
      const missingIds = predefinedIds.filter(id => !currentOrder.includes(id));
      const nextOrder = [...currentOrder.filter(id => predefinedIds.includes(id) || manualIds.includes(id)), ...missingIds];
      return { ...prevOrder, [patientId]: nextOrder };
    });
  };

  // ↺ 頓用薬：「初期状態に戻す」。選択中の定型項目・手動記載・並び順をすべて下書きから消す
  // （まだ保存はされない。実際に消すには従来どおり「保存する」で管理者パスワードを確認する）
  const handleResetAllPrn = (patientId: string) => {
    const confirmReset = window.confirm('頓用薬の選択をすべて消去して初期状態に戻します。よろしいですか？');
    if (!confirmReset) return;
    setPrnDraftSelections(prev => ({ ...prev, [patientId]: {} }));
    setPrnDraftManualEntries(prev => ({ ...prev, [patientId]: [] }));
    setPrnDraftOrder(prev => ({ ...prev, [patientId]: [] }));
  };

  // ✍️ 頓用薬：手動記載を下書きに1件追加する（カテゴリ名も一緒に。パスワードは不要・まだ保存されない）
  const handleAddDraftManualPrn = (patientId: string) => {
    const text = (manualPrnInput[patientId] || '').trim();
    if (!text) return;
    const group = (manualPrnGroupInput[patientId] || '').trim();

    // 🚫 すでに選択済みの定型項目や、すでに記載済みの手動記載と同じ内容なら二重に記載させない
    const draftSelections = prnDraftSelections[patientId] || {};
    const selectedPredefinedTexts = Object.values(draftSelections).flat()
      .map(id => PRN_MEDICATION_OPTIONS.find(o => o.id === id)?.text)
      .filter((t): t is string => Boolean(t));
    const existingManualTexts = (prnDraftManualEntries[patientId] || []).map(e => e.text);
    if ([...selectedPredefinedTexts, ...existingManualTexts].includes(text)) {
      alert('⚠️ 同じ内容がすでに選択・記載されています。');
      return;
    }

    const newId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    setPrnDraftManualEntries(prev => ({
      ...prev,
      [patientId]: [...(prev[patientId] || []), { id: newId, group, text, addedBy: loggedInUser || '不明なユーザー', addedAt: formatNowTimestamp() }],
    }));
    // 🏷️ カテゴリ名（タイトル）が既存の項目と同じ場合は、同じ【タイトル】の下にまとまるよう、
    // その最後の項目のすぐ後ろに挿入する（無ければこれまで通り末尾に追加）
    setPrnDraftOrder(prev => {
      const currentOrder = prev[patientId] || [];
      if (!group) {
        return { ...prev, [patientId]: [...currentOrder, newId] };
      }
      const manualDraftNow = prnDraftManualEntries[patientId] || [];
      const getGroupForId = (id: string): string => {
        const opt = PRN_MEDICATION_OPTIONS.find(o => o.id === id);
        if (opt) return opt.group;
        return manualDraftNow.find(e => e.id === id)?.group || '';
      };
      let insertAt = currentOrder.length;
      for (let i = currentOrder.length - 1; i >= 0; i--) {
        if (getGroupForId(currentOrder[i]) === group) {
          insertAt = i + 1;
          break;
        }
      }
      const nextOrder = [...currentOrder.slice(0, insertAt), newId, ...currentOrder.slice(insertAt)];
      return { ...prev, [patientId]: nextOrder };
    });
    setManualPrnInput(prev => ({ ...prev, [patientId]: '' }));
    setManualPrnGroupInput(prev => ({ ...prev, [patientId]: '' }));
  };

  // ✍️ 頓用薬：手動記載を下書きから削除する
  const handleRemoveDraftManualPrn = (patientId: string, entryId: string) => {
    setPrnDraftManualEntries(prev => ({
      ...prev,
      [patientId]: (prev[patientId] || []).filter(e => e.id !== entryId),
    }));
    setPrnDraftOrder(prev => ({ ...prev, [patientId]: (prev[patientId] || []).filter(id => id !== entryId) }));
  };

  // 🔀 頓用薬：選択済み一覧をドラッグで並べ替える
  const handlePrnDragStart = (index: number) => setPrnDragIndex(index);
  const handlePrnDragOver = (e: React.DragEvent) => e.preventDefault();
  const handlePrnDrop = (patientId: string, dropIndex: number) => {
    if (prnDragIndex === null || prnDragIndex === dropIndex) return;
    setPrnDraftOrder(prev => {
      const order = [...(prev[patientId] || [])];
      const [moved] = order.splice(prnDragIndex, 1);
      order.splice(dropIndex, 0, moved);
      return { ...prev, [patientId]: order };
    });
    setPrnDragIndex(null);
  };

  // 💾 頓用薬：1人分の下書き（定型項目＋手動記載＋並び順）から、保存後のPatientの状態を計算する（右上の一括保存で使う共通処理）
  // ※選択しなかった項目はchecked:falseのまま記録に残らず、▼を開いても表示されない
  const buildPrnSavedPatient = (p: Patient): Patient => {
    const draft = prnDraftSelections[p.id] || {};
    const manualDraft = prnDraftManualEntries[p.id] || [];
    const orderDraft = prnDraftOrder[p.id] || [];

    const nextPrnMedications = { ...p.prnMedications };
    PRN_MEDICATION_OPTIONS.forEach(opt => {
      const selectedIdsForGroup = draft[opt.group] || [];
      if (selectedIdsForGroup.includes(opt.id)) {
        const already = p.prnMedications[opt.id];
        nextPrnMedications[opt.id] = already?.checked
          ? already // すでに選択済みだった項目は実施者・日時を保持する
          : { checked: true, checkedBy: loggedInUser || '不明なユーザー', checkedAt: formatNowTimestamp() };
      } else {
        // 選択しなかった項目はchecked: falseのみのシンプルな状態にし、記録に残さない
        nextPrnMedications[opt.id] = { checked: false };
      }
    });

    return touchLastEdited({ ...p, prnMedications: nextPrnMedications, prnManualEntries: manualDraft, prnSelectedOrder: orderDraft });
  };

  // 💾 頓用薬：患者ごとの「保存する」ボタン。パスワードなしですぐにその1人分の下書きを確定する
  // （管理者パスワードの確認は、画面右上の「保存」でまとめて保存する時に1回だけ行う）
  const handleSavePrnSelections = (patientId: string) => {
    setPatients(prev => prev.map(p => (p.id === patientId ? buildPrnSavedPatient(p) : p)));
    setOpenPrnPatientIds(prev => ({ ...prev, [patientId]: false }));
    setPrnAddSectionOpenIds(prev => ({ ...prev, [patientId]: false }));
  };

  // 💾 頓用薬：画面右上の「保存」ボタン。管理者パスワードを1回だけ確認し、パネルを開いている（＝下書きが
  // ある）全員分をまとめて保存する
  const handleSaveAllPrn = () => {
    const editingPatientIds = Object.keys(openPrnPatientIds).filter(id => openPrnPatientIds[id]);
    if (editingPatientIds.length === 0) {
      alert('頓用薬パネルが開いている方がいません。氏名の下の「💊 頓用薬」を開いて選択してから保存してください。');
      return;
    }

    const MASTER_PASSWORD = 'master999';
    const inputPassword = prompt('⚠️ 頓用薬の保存には管理者パスワードが必要です。\nパスワードを入力してください：');
    if (inputPassword === null) return;
    if (inputPassword !== MASTER_PASSWORD) {
      alert('❌ パスワードが正しくありません。保存は取り消されました。');
      return;
    }

    const editingIdSet = new Set(editingPatientIds);
    setPatients(prev => prev.map(p => (editingIdSet.has(p.id) ? buildPrnSavedPatient(p) : p)));
    setOpenPrnPatientIds({});
    setPrnAddSectionOpenIds({});
  };

  // ✏️ 頓用薬の文言をクリックで書き直す（患者ごとに文言を上書きできる。パスワードは不要）
  const [editingPrn, setEditingPrn] = useState<{ patientId: string; itemId: string } | null>(null);
  const [editingPrnText, setEditingPrnText] = useState('');

  const getPrnMedicationText = (p: Patient, opt: { id: string; text: string }): string => {
    return p.prnMedicationTextOverrides[opt.id] ?? opt.text;
  };

  const handleStartEditPrn = (patientId: string, itemId: string, currentText: string) => {
    setEditingPrn({ patientId, itemId });
    setEditingPrnText(currentText);
  };

  const handleCommitEditPrn = () => {
    if (!editingPrn) return;
    const { patientId, itemId } = editingPrn;
    const trimmed = editingPrnText.trim();

    if (!trimmed) {
      setEditingPrn(null);
      return;
    }

    setPatients(prev => prev.map(p => {
      if (p.id !== patientId) return p;
      return touchLastEdited({
        ...p,
        prnMedicationTextOverrides: { ...p.prnMedicationTextOverrides, [itemId]: trimmed },
        prnMedicationTextMeta: { ...p.prnMedicationTextMeta, [itemId]: { editedBy: loggedInUser || '不明なユーザー', editedAt: formatNowTimestamp() } },
      });
    }));

    setEditingPrn(null);
  };

  // ✏️ 頓用薬の手動記載をクリックで書き直す（選択済み一覧の下書きを直接書き換える。パスワードは不要）
  const [editingManualPrn, setEditingManualPrn] = useState<{ patientId: string; entryId: string } | null>(null);
  const [editingManualPrnText, setEditingManualPrnText] = useState('');

  const handleStartEditManualPrn = (patientId: string, entryId: string, currentText: string) => {
    setEditingManualPrn({ patientId, entryId });
    setEditingManualPrnText(currentText);
  };

  const handleCommitEditManualPrn = () => {
    if (!editingManualPrn) return;
    const { patientId, entryId } = editingManualPrn;
    const trimmed = editingManualPrnText.trim();
    setEditingManualPrn(null);
    if (!trimmed) return;

    setPrnDraftManualEntries(prev => ({
      ...prev,
      [patientId]: (prev[patientId] || []).map(e => (e.id === entryId ? { ...e, text: trimmed } : e)),
    }));
  };

  const setTwoWeeksInterval = (patientId: string) => {
    const today = new Date();
    const nextDate = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
    handleUpdate(patientId, 'lastExchangeDate', today.toISOString().split('T')[0]);
    handleUpdate(patientId, 'nextExchangeDate', nextDate.toISOString().split('T')[0]);
  };

  const handleExchangeToggle = (patientId: string) => {
    setPatients(prev => prev.map(p => p.id === patientId ? { ...p, isExchangeChecked: !p.isExchangeChecked } : p));
  };

  // ⚠️ 定数（allocated）を書き換えた時は、毎月1日に戻す基準値（baseAllocated）も一緒に更新する
  //    （手動での書き換えは「これからの標準の定数」を決め直す操作とみなすため）
  const handleUpdateSupply = (patientId: string, supplyId: string, key: 'allocated' | 'stock', value: number) => {
    const clamped = Math.max(0, value);
    updateSupplyDraftList(patientId, list => list.map(s => {
      if (s.id !== supplyId) return s;
      return key === 'allocated' ? { ...s, allocated: clamped, baseAllocated: clamped } : { ...s, stock: clamped };
    }));
  };

  // 📦 定数はクリックしないと書き換えられない固定表示にする。クリックで編集を始め、確定すると
  // 「変更しますね」とお知らせしてから反映する（数値が変わっていない時はお知らせしない）
  const handleStartEditSupplyAllocated = (patientId: string, supplyId: string, currentValue: number) => {
    setEditingSupplyAllocatedKey(`${patientId}::${supplyId}`);
    setEditingSupplyAllocatedValue(String(currentValue));
  };
  // 📍 rect：変更した定数欄の画面上の位置。お知らせをその操作した場所の近くに表示するために使う
  const handleCommitEditSupplyAllocated = (patientId: string, supplyId: string, currentValue: number, rect: DOMRect) => {
    const nextValue = Math.max(0, parseInt(editingSupplyAllocatedValue, 10) || 0);
    if (nextValue !== currentValue) {
      const left = Math.min(Math.max(rect.left + rect.width / 2, 90), window.innerWidth - 90);
      setSupplyChangeToast({ patientId, supplyId, previousValue: currentValue, top: rect.bottom + 8, left });
      handleUpdateSupply(patientId, supplyId, 'allocated', nextValue);
    }
    setEditingSupplyAllocatedKey(null);
  };

  // 📦 物品名の下に表示するメモ（用途：必要定数変更・追加調達依頼内容など）を更新する
  const handleUpdateSupplyMemo = (patientId: string, supplyId: string, memo: string) => {
    updateSupplyDraftList(patientId, list => list.map(s => s.id === supplyId ? { ...s, memo } : s));
  };

  // 📦 物品管理の月を1つだけ繰り上げる計算（setStateは呼ばない、純粋な計算だけ）。
  // fromMonth（元の月）の物品データを履歴スナップショットにし、toMonth（次の月）へ同じ構成
  // （氏名・物品名・定数・単位・曜日パターン）を引き継いだ新しいpatients・commonSuppliesを返す。
  // ただし「臨時」の物品はその月限りなので引き継がない（一覧から消える）。在庫は定数と同じ数でスタートする。
  // すでにfromMonthの記録があれば（二重に繰り上げないよう）nullを返す
  const computeSupplyMonthAdvance = (
    fromMonth: string,
    toMonth: string,
    currentPatients: Patient[],
    currentCommonSupplies: SupplyItem[],
    archive: Record<string, SupplyMonthlySnapshot>,
  ): { snapshot: SupplyMonthlySnapshot; nextPatients: Patient[]; nextCommonSupplies: SupplyItem[] } | null => {
    if (archive[fromMonth]) return null;
    const hasNamedSupply = (list: SupplyItem[]) => list.some(s => s.name.trim() !== '');
    const snapshot: SupplyMonthlySnapshot = {
      patients: currentPatients
        .filter(p => hasNamedSupply(p.supplies))
        .map(p => ({ patientId: p.id, room: p.room, name: p.name, supplies: p.supplies })),
      commonSupplies: currentCommonSupplies.filter(s => s.name.trim() !== ''),
    };
    // 🔁 次の月の物品を作る（「臨時」は引き継がず除外する。在庫は定数と同じ数にリセットし、
    //    使用予定日は曜日×間隔のパターンがあれば新しい月の分を自動で作り直す）
    const carryForwardItem = (s: SupplyItem): SupplyItem => {
      if (s.recurringPattern) {
        // 📅 曜日×間隔（2週間おき／30日おき）の物品は、月によって回数が変わる（例：3回の月と2回の月）ため、
        // 前の月の定数をそのまま引き継がず、次の月に実際に生成された日にちの数へ定数・基準定数を合わせ直す
        const scheduledUseDates = generateRecurringWeekdayDates(toMonth, s.recurringPattern.weekday, s.recurringPattern.intervalDays).map(date => ({ date, applied: false }));
        const count = scheduledUseDates.length;
        return { ...s, allocated: count, baseAllocated: count, lastResetMonth: toMonth, stock: count, scheduledUseDates };
      }
      return { ...s, allocated: s.baseAllocated, lastResetMonth: toMonth, stock: s.baseAllocated, scheduledUseDates: [] };
    };
    const nextPatients = currentPatients.map(p => {
      if (p.supplies.length === 0) return p;
      const carried = p.supplies.filter(s => (s.kind || '定数') !== '臨時').map(carryForwardItem);
      return touchLastEdited({ ...p, supplies: carried });
    });
    const nextCommonSupplies = currentCommonSupplies.filter(s => (s.kind || '定数') !== '臨時').map(carryForwardItem);
    return { snapshot, nextPatients, nextCommonSupplies };
  };

  // 📦 物品管理の「今のデータが表している月（supplyLiveMonth）」を、目的の月（targetMonth）まで進める。
  // 「▶」を1回押した時はもちろん、請求月のカレンダーで一気に数か月先を選んだ時も、間の月を1か月ずつ
  // 正しく繰り上げてから目的の月へ到達する（履歴保存・臨時の除外・曜日パターンの引き継ぎを毎月分行う）。
  // targetMonthがsupplyLiveMonth以前（同じ月・過去）の場合は、実データを動かす必要が無いので何もしない
  const advanceSupplyLiveMonthTo = (targetMonth: string) => {
    const startMonth = supplyLiveMonth || getTodayISO().slice(0, 7);
    if (targetMonth <= startMonth) return;
    // 📦 保存していない下書きがあれば、最初の1歩だけ合流させてから繰り上げる
    let currentPatients = supplyDraft
      ? patients.map(p => {
          const nextSupplies = supplyDraft.patientSupplies[p.id];
          return (!nextSupplies || nextSupplies === p.supplies) ? p : touchLastEdited({ ...p, supplies: nextSupplies });
        })
      : patients;
    let currentCommonSupplies = supplyDraft ? supplyDraft.commonSupplies : commonSupplies;
    const archiveAdditions: Record<string, SupplyMonthlySnapshot> = {};
    let month = startMonth;
    while (month < targetMonth) {
      const next = shiftMonthISO(month, 1);
      const result = computeSupplyMonthAdvance(month, next, currentPatients, currentCommonSupplies, { ...supplyMonthlyArchive, ...archiveAdditions });
      // 🔧 その月がすでに記録済み（result===null）でも、月だけは先へ進める。以前の不具合で
      //    「記録はあるのにsupplyLiveMonthだけ遅れている」状態になっていても、ここで追いつかせて直す
      if (result) {
        archiveAdditions[month] = result.snapshot;
        currentPatients = result.nextPatients;
        currentCommonSupplies = result.nextCommonSupplies;
      }
      month = next;
    }
    setSupplyMonthlyArchive(prev => ({ ...prev, ...archiveAdditions }));
    setPatients(currentPatients);
    setCommonSupplies(currentCommonSupplies);
    setSupplyDraft(null);
    setSupplyLiveMonth(month);
    if (typeof window !== 'undefined') localStorage.setItem('oncall_supply_live_month', month);
  };

  // 🗓️ 定数の右の🗓️から開く、使用予定日カレンダー。日にちの選択に制限はなく、複数選べる。
  // すでに「曜日×間隔（2週間おき／30日おき）」のパターンが保存されている物品を開いた時は、
  // その曜日・間隔のボタンを選択済みの状態で表示する（翌月に進んだ後も、設定していたことが分かるように）。
  // カレンダーが最初に表示する月は、今日の実月ではなく「今、物品管理で見ている請求月（billingMonth）」に合わせる
  // （9月→▶→10月と進めた後にこのカレンダーを開いたら、10月のカレンダーが出るように）
  const openSupplyDateCalendar = (patientId: string, supplyId: string) => {
    const supplies = patientId === COMMON_SUPPLY_ID ? (supplyDraft?.commonSupplies ?? commonSupplies) : (supplyDraft?.patientSupplies[patientId] ?? patients.find(p => p.id === patientId)?.supplies ?? []);
    const existing = supplies.find(s => s.id === supplyId);
    setOpenSupplyDateCalendarKey(`${patientId}::${supplyId}`);
    // 📅 上部の「作成日」と食い違わないよう、この物品のカレンダーもbillingMonthではなく作成日から開始する
    setSupplyDateCalendarMonth((supplyItemCreationDate || getTodayISO()).slice(0, 7));
    setSupplyDateDraftSelection([]);
    setSupplyRecurringWeekday(existing?.recurringPattern?.weekday ?? null);
    setSupplyRecurringIntervalDays(existing?.recurringPattern?.intervalDays ?? null);
  };
  const shiftSupplyDateCalendarMonth = (deltaMonths: number) => {
    setSupplyDateCalendarMonth(prev => {
      const [y, m] = (prev || getTodayISO().slice(0, 7)).split('-').map(Number);
      const d = new Date(y, m - 1 + deltaMonths, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    });
  };
  // 🗓️ カレンダー内での複数選択（保存を押すまではこの下書きだけを更新する）。
  // maxAdditional：この物品にあと何件まで「定数の範囲内」で使用予定日を追加できるか（定数 − すでに保存済みの件数）。
  // これを超えて選ぼうとした場合は「定数以上になります」と確認し、OKなら超過分として追加する
  // （超過分は保存後、一覧で赤字・赤いレ点で警告表示される。キャンセルなら追加しない）
  const toggleSupplyDateDraftSelection = (iso: string, maxAdditional: number) => {
    setSupplyDateDraftSelection(prev => {
      if (prev.includes(iso)) return prev.filter(d => d !== iso);
      if (prev.length >= maxAdditional && !window.confirm('定数以上になります。それでも追加しますか？')) {
        return prev;
      }
      return [...prev, iso];
    });
  };
  // 🗓️ 選んだ曜日×間隔（2週間おき／30日おき）から、表示中の月に当てはまる日にちをまとめて下書き選択へ追加する。
  // 例：月・2週間おきを9月で選ぶと、9/7・9/21のように自動で入力される
  // （定数の残り件数を超える場合は「定数以上になります」と確認し、OKなら超過分として追加する）
  const handleApplyRecurringSupplyDates = (intervalDays: number, maxAdditional: number) => {
    if (supplyRecurringWeekday === null) return;
    setSupplyRecurringIntervalDays(intervalDays);
    const monthIso = supplyDateCalendarMonth || getTodayISO().slice(0, 7);
    const dates = generateRecurringWeekdayDates(monthIso, supplyRecurringWeekday, intervalDays);
    setSupplyDateDraftSelection(prev => {
      const newDates = dates.filter(d => !prev.includes(d));
      if (prev.length + newDates.length > maxAdditional && !window.confirm('定数以上になります。それでも追加しますか？')) {
        return prev;
      }
      return [...prev, ...newDates];
    });
  };
  // 🗓️ 選択した使用予定日をまとめて保存する（ログインした日（今日）がその日を迎えると、自動で定数・在庫を1ずつ減らす）。
  // 曜日×間隔（2週間おき／30日おき）を使っていた場合は、そのパターンも一緒に記録し、
  // 「翌月に進む」で次の月の使用予定日を自動生成する時に使う
  const handleSaveSupplyUseDates = (patientId: string, supplyId: string) => {
    const datesToAdd = supplyDateDraftSelection;
    const recurringPattern = (supplyRecurringWeekday !== null && supplyRecurringIntervalDays !== null)
      ? { weekday: supplyRecurringWeekday, intervalDays: supplyRecurringIntervalDays }
      : undefined;
    updateSupplyDraftList(patientId, list => list.map(s => {
      if (s.id !== supplyId) return s;
      const existingDates = new Set(s.scheduledUseDates.map(e => e.date));
      const newEntries = datesToAdd.filter(d => !existingDates.has(d)).map(d => ({ date: d, applied: false }));
      const nextScheduledUseDates = newEntries.length === 0 ? s.scheduledUseDates : [...s.scheduledUseDates, ...newEntries];
      // 📅 曜日×間隔（2週間おき／30日おき）でまとめて選んだ場合は、その月に実際に何回になったか（例：3回／2回）に
      // 合わせて、この物品だけ定数・基準定数・在庫を自動で揃える（カレンダーで選んでいない他の物品には影響しない）。
      // 在庫はここで定数と同じ数にそろえ、以降は使用予定日のレ点をチェックするたびに1ずつ減っていく
      if (recurringPattern) {
        const count = nextScheduledUseDates.length;
        return { ...s, scheduledUseDates: nextScheduledUseDates, recurringPattern, allocated: count, baseAllocated: count, stock: count };
      }
      return { ...s, scheduledUseDates: nextScheduledUseDates, recurringPattern: s.recurringPattern };
    }));
    setOpenSupplyDateCalendarKey(null);
    setSupplyDateDraftSelection([]);
    setSupplyRecurringWeekday(null);
    setSupplyRecurringIntervalDays(null);
  };
  // ✅ 使用予定日の左のレ点：チェックすると在庫を1減らし、チェックを外すと在庫を1戻す
  //    （定数は変わらない。定数は「毎月必要な数」であり、実際に使った分の記録は在庫だけで管理する）
  const handleToggleSupplyUseDateChecked = (patientId: string, supplyId: string, date: string) => {
    updateSupplyDraftList(patientId, list => list.map(s => {
      if (s.id !== supplyId) return s;
      const entry = s.scheduledUseDates.find(e => e.date === date);
      if (!entry) return s;
      const nowChecked = !entry.applied;
      const nextDates = s.scheduledUseDates.map(e => e.date === date ? { ...e, applied: nowChecked } : e);
      const nextStock = Math.max(0, s.stock + (nowChecked ? -1 : 1));
      return { ...s, stock: nextStock, scheduledUseDates: nextDates };
    }));
  };
  // ✏️ まだチェックしていない使用予定日を1件だけ取り消す（チェック済みの日にちは在庫に反映済みのため、
  //    先にチェックを外してから消す）
  const handleRemoveSupplyUseDate = (patientId: string, supplyId: string, date: string) => {
    updateSupplyDraftList(patientId, list => list.map(s => s.id === supplyId
      ? { ...s, scheduledUseDates: s.scheduledUseDates.filter(e => e.date !== date) }
      : s
    ));
  };
  // 📦 物品名の×：使わなくなった物品を一覧から消す。全ての物品が無くなると、その人の名前も
  // 物品管理の一覧から自動的に消える（一覧表示は「物品名がある人だけ」を条件にしているため。共通物品も同様）
  const handleRemoveSupplyItem = (patientId: string, supplyId: string) => {
    updateSupplyDraftList(patientId, list => list.filter(s => s.id !== supplyId));
  };

  // 🔢 電卓ポップアップを開く関数
  const openKeypad = (patient: Patient, field: 'kt' | 'bp' | 'spo2' | 'p', label: string) => {
    setKeypadConfig({
      isOpen: true,
      patientId: patient.id,
      patientName: `${patient.room} ${patient.name}`,
      field: field,
      label: label,
      value: patient[field] || ''
    });
  };

  // 🔢 電卓のボタンを押した時の処理
  const handleKeypadPress = (key: string) => {
    setKeypadConfig(prev => {
      let nextValue = prev.value;
      if (key === 'C') {
        nextValue = '';
      } else if (key === '⌫') {
        nextValue = nextValue.slice(0, -1);
      } else if (key === '.') {
        if (prev.field !== 'bp' && nextValue.includes('.')) return prev;
        nextValue += key;
      } else if (key === '/' || key === '-') {
        // 🩸 血圧（BP）の上/下の区切りは1つまでしか入力できないようにする
        if (prev.field === 'bp' && /[/-]/.test(nextValue)) return prev;
        nextValue += key;
      } else {
        // 🌡️ 体温（KT）は「〇〇.〇」の形（整数部2桁・小数部1桁）までしか入力できないようにする
        //    （制限が無いと「36.3333」のように延々と数字が入力できてしまうため）
        if (prev.field === 'kt') {
          const dotIndex = nextValue.indexOf('.');
          if (dotIndex === -1) {
            if (nextValue.length >= 2) return prev;
          } else if (nextValue.length - dotIndex - 1 >= 1) {
            return prev;
          }
        }
        // 🩸 血圧（BP）は「〇〇/〇〇」「〇〇〇/〇〇」の形（上は2〜3桁・下は2桁）までしか入力できないようにする
        if (prev.field === 'bp') {
          const sepMatch = nextValue.match(/[/-]/);
          if (sepMatch && sepMatch.index !== undefined) {
            if (nextValue.length - sepMatch.index - 1 >= 2) return prev;
          } else if (nextValue.length >= 3) {
            return prev;
          }
        }
        // 🌬️ 酸素飽和度（SpO2）は「〇〇」の形（2桁）までしか入力できないようにする
        if (prev.field === 'spo2' && nextValue.length >= 2) return prev;
        // 💓 脈拍（P）は「〇〇」「〇〇〇」の形（2〜3桁）までしか入力できないようにする
        if (prev.field === 'p' && nextValue.length >= 3) return prev;
        nextValue += key;
      }
      return { ...prev, value: nextValue };
    });
  };

  // 🔢 確定ボタン押下時に異常値を完全に遮断する（下書きに反映。実データへは1.バイタルの保存ボタンで反映）
  const saveKeypadValue = () => {
    const { field, value } = keypadConfig;
    const trimmedValue = value.trim();

    if (trimmedValue === '') {
      handleUpdate(keypadConfig.patientId, field, '');
      setKeypadConfig(prev => ({ ...prev, isOpen: false }));
      return;
    }

    if (field === 'kt') {
      const num = parseFloat(trimmedValue);
      if (isNaN(num) || num < 30.0 || num > 45.0) {
        alert(`❌ 【入力エラー】\n体温の数値が異常です (${trimmedValue}℃)\n30.0℃ ～ 45.0℃ の現実的な範囲内で入力してください。`);
        return;
      }
    }

    if (field === 'spo2') {
      const num = parseFloat(trimmedValue);
      if (isNaN(num) || num < 50 || num > 100) {
        alert(`❌ 【入力エラー】\nSpO2の数値が異常です (${trimmedValue}%)\n50% ～ 100% の範囲内で入力してください。`);
        return;
      }
    }

    if (field === 'p') {
      const num = parseFloat(trimmedValue);
      if (isNaN(num) || num < 20 || num > 250) {
        alert(`❌ 【入力エラー】\n脈拍の数値が異常です (${trimmedValue}回)\n20回 ～ 250回 の範囲内で入力してください。`);
        return;
      }
    }

    if (field === 'bp') {
      const parts = trimmedValue.split(/[/|-]/);
      const sbp = parseFloat(parts[0]);
      const dbp = parseFloat(parts[1]);

      if (isNaN(sbp) || sbp < 40 || sbp > 300) {
        alert(`❌ 【入力エラー】\n血圧(上)の数値が異常です (${parts[0] || '未入力'})\n40 ～ 300 の正常な範囲内で入力してください。`);
        return;
      }
      if (parts[1] !== undefined && parts[1] !== '') {
        if (isNaN(dbp) || dbp < 20 || dbp > 200) {
          alert(`❌ 【入力エラー】\n血圧(下)の数値が異常です (${parts[1]})\n20 ～ 200 の範囲内で入力してください。`);
          return;
        }
      }
    }

    handleUpdate(keypadConfig.patientId, field, trimmedValue);
    setKeypadConfig(prev => ({ ...prev, isOpen: false }));
  };

  // ==========================================
  // 🩺 各種バイタルのアラート判定関数群 (薄赤背景表示用)
  // ==========================================
  const isKtAlert = (val: string): boolean => {
    if (!val) return false;
    const num = parseFloat(val);
    return !isNaN(num) && (num <= 35.0 || num >= 37.5);
  };

  const isPAlert = (val: string): boolean => {
    if (!val) return false;
    const num = parseFloat(val);
    return !isNaN(num) && (num <= 40 || num >= 100);
  };

  const isSpO2Alert = (val: string): boolean => {
    if (!val) return false;
    const num = parseFloat(val);
    return !isNaN(num) && num <= 92;
  };

  const isBpAlert = (val: string): boolean => {
    if (!val) return false;
    const parts = val.split(/[/|-]/);
    const sbp = parseFloat(parts[0]);
    const dbp = parseFloat(parts[1]);
    if (isNaN(sbp)) return false;
    if (sbp >= 160) return true;
    if (!isNaN(dbp) && dbp <= 40) return true;
    return false;
  };

  // 🩸 血圧は上（160以上）・下（40以下）で基準が異なるため、例えば「161/60」なら上だけ赤字にする
  //    （下は基準内なので黒字のまま）というように、上下それぞれ独立に色分けして表示する
  const renderBpValue = (bp: string): React.ReactNode => {
    const sepMatch = bp.match(/[/-]/);
    if (!sepMatch || sepMatch.index === undefined) {
      const num = parseFloat(bp);
      const alert = !isNaN(num) && num >= 160;
      return <span className={alert ? 'text-rose-600' : 'text-slate-700'}>{bp}</span>;
    }
    const sep = sepMatch[0];
    const sbpStr = bp.slice(0, sepMatch.index);
    const dbpStr = bp.slice(sepMatch.index + 1);
    const sbp = parseFloat(sbpStr);
    const dbp = parseFloat(dbpStr);
    const sbpAlert = !isNaN(sbp) && sbp >= 160;
    const dbpAlert = !isNaN(dbp) && dbp <= 40;
    return (
      <>
        <span className={sbpAlert ? 'text-rose-600' : 'text-slate-700'}>{sbpStr}</span>
        <span className="text-slate-700">{sep}</span>
        <span className={dbpAlert ? 'text-rose-600' : 'text-slate-700'}>{dbpStr}</span>
      </>
    );
  };

  const checkFieldAlert = (field: 'kt' | 'bp' | 'spo2' | 'p', val: string): boolean => {
    if (field === 'kt') return isKtAlert(val);
    if (field === 'bp') return isBpAlert(val);
    if (field === 'spo2') return isSpO2Alert(val);
    if (field === 'p') return isPAlert(val);
    return false;
  };

  const getFieldStyle = (field: 'kt' | 'bp' | 'spo2' | 'p', val: string): string => {
    const alert = checkFieldAlert(field, val);
    if (alert) {
      return 'border-rose-300 bg-rose-50 text-rose-700 font-extrabold shadow-inner';
    }
    return 'border-emerald-100 bg-emerald-50/30 text-emerald-800 font-bold';
  };

  // 🚻 性別によって氏名の文字色を分ける（男性:黒 / 女性:赤）
  const getNameColorClass = (gender: 'male' | 'female'): string => {
    return gender === 'female' ? 'text-rose-600' : 'text-black';
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[#f7fbf9] flex items-center justify-center p-4 text-slate-800 antialiased">
        <div className="bg-white p-8 rounded-3xl border border-emerald-100 shadow-xl w-full max-w-md space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold text-emerald-900">🏥 オンコールシステム</h1>
            <p className="text-xs text-slate-500">医療スタッフ専用ページです。ログインしてください。</p>
          </div>
          {/* 🚨 ログイン前でも急ぎの用件に気づけるよう、③指示内容にアラート対象の項目があれば
             ログイン画面の時点でピカピカ点滅させて知らせる（ログインしてからでは遅いため）。
             開始日前日（黄）と開始日当日以降（赤）を、上下2段に分けて別々に知らせる */}
          {patients.some(p => patientHasOrderAlertLevel(p, 'yellow')) && (
            <div className="order-blink-yellow text-center text-sm font-bold text-amber-700 border border-amber-400 rounded-xl py-2.5">
              🚨 医師指示アラームあり
            </div>
          )}
          {patients.some(p => patientHasOrderAlertLevel(p, 'red')) && (
            <div className="order-blink-red text-center text-sm font-bold text-rose-700 border border-rose-300 rounded-xl py-2.5">
              🚨 医師指示アラームあり
            </div>
          )}
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-600 block">ログインID</label>
              <input type="text" value={loginId} onChange={(e) => setLoginId(e.target.value)} className="w-full p-3 border border-slate-200 rounded-xl bg-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-base" placeholder="IDを入力" required />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-bold text-slate-600 block">パスワード</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full p-3 border border-slate-200 rounded-xl bg-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-base" placeholder="パスワードを入力" required />
            </div>
            {loginError && <p className="text-xs text-rose-600 font-bold bg-rose-50 p-2.5 rounded-lg border border-rose-100">⚠️ {loginError}</p>}
            <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold p-3 rounded-xl transition-all shadow-md active:scale-[0.98]">ログイン</button>
          </form>
        </div>
      </div>
    );
  }

  // 🖨️ 緊急時対応サマリーシートを開いている間は、印刷マークを押した時に背後の画面（部屋図など）が
  // 一緒に印刷されてしまわないよう、背後の画面側だけ印刷対象から外す
  const hideMainViewForPrint = !!emergencyModalPatientId || !!viewingHandoverArchiveDate;

  // 💾 VS・医師連携：画面を開いた時点から何か変わっていれば緑、まだ何も変わっていなければグレー
  const hasDoctorScreenChanges = JSON.stringify(patients) !== doctorScreenSavedSnapshot;
  // 💾 観察要点：頓用薬パネルを開いている人のうち、下書きが実データと1件でも違っていれば緑、
  //    まだ何も変わっていなければ（パネルを開いただけなら）グレー
  const hasPrnChanges = Object.keys(openPrnPatientIds).some(id => {
    if (!openPrnPatientIds[id]) return false;
    const p = patients.find(pt => pt.id === id);
    if (!p) return false;
    const saved = buildPrnSavedPatient(p);
    return JSON.stringify({ m: saved.prnMedications, e: saved.prnManualEntries, o: saved.prnSelectedOrder }) !==
      JSON.stringify({ m: p.prnMedications, e: p.prnManualEntries, o: p.prnSelectedOrder });
  });

  return (
    <div className="min-h-screen bg-[#f7fbf9] text-slate-800 antialiased text-sm pb-12">
      <style dangerouslySetInnerHTML={{__html: `
        @media print {
          .no-print, .no-print * { display: none !important; }
          .print-only { display: block !important; }
          body { background: white !important; color: black !important; padding: 0 !important; }
          .print-container { width: 100% !important; max-width: 100% !important; box-shadow: none !important; border: none !important; }
          .print-page-break { page-break-inside: avoid; }
          /* 🚨 緊急時対応サマリーシート：モーダルの背景・枠・スクロール制限を印刷時だけ解除し、中身がそのまま印刷される紙面になるようにする */
          .modal-print-wrap { position: static !important; background: none !important; backdrop-filter: none !important; padding: 0 !important; display: block !important; }
          .modal-print-wrap .modal-print-panel { max-width: 100% !important; width: 100% !important; max-height: none !important; box-shadow: none !important; border: none !important; overflow: visible !important; }
          .modal-print-wrap .modal-print-scroll { overflow: visible !important; }
          /* 🚨 緊急時対応サマリーシート：プレースホルダー（例：「医院名（例：〇〇クリニック）」等）はあくまで
             入力例であり実際に記載された内容ではないため、印刷時は表示せず空欄のまま印刷する */
          .modal-print-panel input::placeholder,
          .modal-print-panel textarea::placeholder {
            color: transparent !important;
            opacity: 0 !important;
            -webkit-text-fill-color: transparent !important;
          }
          /* 🚨 点滅アラートは印刷では意味がないため、印刷時は点滅を止めて通常の見た目にする */
          .order-blink-yellow, .order-blink-red { animation: none !important; background-color: #ffffff !important; border-color: #cbd5e1 !important; }
          /* 📢 業務連絡シート：未来日向けでまだ確定していない内容は、印刷時も画面と同じ薄いグレーで
             印刷する（body側のcolor:black指定より優先させる） */
          .handover-note-pending-print { color: #94a3b8 !important; }
        }
        .print-only { display: none; }
      `}} />

      {/* ナビゲーションバー */}
      <div className="no-print bg-white border-b border-emerald-100 p-2 flex justify-between items-center sticky top-0 z-50 shadow-sm max-w-full overflow-x-auto">
        <div className="flex space-x-1.5 min-w-max">
          {([
            { id: 'map', label: '🏠 部屋図', color: 'text-purple-800 border-purple-200' },
            { id: 'handover', label: '📢 業務連絡', color: 'text-purple-800 border-purple-200' },
            { id: 'summary', label: '📋 観察要点', color: 'text-purple-800 border-purple-200' },
            { id: 'doctor', label: '👨‍⚕️ VS・医師連携', color: 'text-amber-900 border-amber-300' },
            { id: 'supply', label: '📦 物品管理', color: 'text-amber-900 border-amber-300' }
          ] as const).map(tab => (
            <button key={tab.id} onClick={() => setCurrentView(tab.id)} className={`px-3 py-2 rounded-xl font-bold border ${currentView === tab.id ? 'bg-[#ecf7f2] border-emerald-300 shadow-sm' : 'bg-white'} ${tab.color}`}>
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 ml-4 shrink-0">
          <button onClick={handleOpenStaffAccountManager} title="ログインできるスタッフID・パスワードを管理します（管理者パスワードが必要です）" className="px-3 py-2 text-xs font-bold text-purple-800 hover:text-white bg-slate-50 hover:bg-slate-600 border rounded-xl transition-all whitespace-nowrap">🆔 スタッフ管理</button>
          <button onClick={handleLogout} className="px-3 py-2 text-xs font-bold text-purple-800 hover:text-rose-600 bg-slate-50 hover:bg-rose-50 border rounded-xl transition-all">🚪 ログアウト</button>
          <span className="px-2 text-xs font-bold text-emerald-800 whitespace-nowrap">🗓️ {todayLabel}</span>
        </div>
      </div>

      {/* 👤 スタッフ管理：ログインできるID・パスワードの追加・削除。管理者パスワードで開く */}
      {isStaffAccountManagerOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 no-print">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-2xl w-full max-w-md p-5">
            <div className="flex justify-between items-center mb-3">
              <h2 className="text-base font-bold text-slate-800">🆔 スタッフ管理</h2>
              <button onClick={() => setIsStaffAccountManagerOpen(false)} className="text-2xl font-normal text-slate-400 hover:text-rose-500">✕</button>
            </div>
            <div className="space-y-2 mb-4 max-h-60 overflow-y-auto">
              {staffAccounts.map(acc => (
                <div key={acc.id} className="flex items-center justify-between gap-2 p-2 border border-slate-200 rounded-xl">
                  <div className="text-xs">
                    <div className="font-bold text-slate-700">{acc.name || '（氏名未設定）'}</div>
                    <div className="text-slate-500">ID: {acc.id}</div>
                    <div className="text-slate-400 font-mono">PW: {acc.password}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteStaffAccount(acc.id)}
                    className="shrink-0 text-xs font-bold text-rose-600 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg px-2 py-1"
                  >
                    削除
                  </button>
                </div>
              ))}
            </div>
            <div className="border-t border-slate-100 pt-3 space-y-2">
              <div className="text-xs font-bold text-slate-600">新しいスタッフを追加</div>
              <input
                type="text"
                value={newStaffName}
                onChange={e => setNewStaffName(e.target.value)}
                placeholder="氏名"
                className="w-full p-2 border border-slate-200 rounded-lg text-sm"
              />
              <input
                type="text"
                value={newStaffId}
                onChange={e => setNewStaffId(e.target.value)}
                placeholder="ID"
                className="w-full p-2 border border-slate-200 rounded-lg text-sm"
              />
              <input
                type="text"
                value={newStaffPassword}
                onChange={e => setNewStaffPassword(e.target.value)}
                placeholder="パスワード"
                className="w-full p-2 border border-slate-200 rounded-lg text-sm"
              />
              <button
                type="button"
                onClick={handleAddStaffAccount}
                className="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-4 py-2 rounded-xl"
              >
                ＋ 追加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 画面[0]: フロアMap */}
      {currentView === 'map' && (
        <div className={`print-container max-w-7xl mx-auto px-4 py-6 space-y-8 ${hideMainViewForPrint ? 'no-print' : ''}`}>
          <div className="flex justify-between items-center mb-1">
            <h2 className="text-xl font-bold text-purple-900">🏠 施設フロアマップ（意思決定・緊急時対応）</h2>
            <div className="flex items-center gap-3">
              <button onClick={() => window.print()} className="no-print bg-purple-100 text-purple-800 px-4 py-2 rounded-xl font-bold border border-purple-300">🖨️</button>
              <button onClick={handleUndoLastPatientsChange} className="no-print bg-purple-100 text-purple-800 px-4 py-2 rounded-xl font-bold border border-purple-300" title="直前の編集を1件取り消します">↩️ 元に戻す</button>
            </div>
          </div>
          <div className="text-right text-xs font-bold text-purple-700 whitespace-nowrap mb-3">{todayLabel}</div>
          {FLOOR_ROOM_LISTS.map((floor) => (
            <div key={floor.label} className="bg-white p-6 rounded-3xl border border-purple-100 shadow-sm print-page-break">
              <h3 className="text-lg font-bold text-purple-800 mb-4 border-b-2 border-purple-100 pb-2">{floor.label}</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
                {floor.rooms.map((room) => {
                    const p = patients.find(patient => patient.room === room);
                    if (!p) {
                      return (
                        <div
                          key={room}
                          onClick={() => handleAssignRoom(room)}
                          role="button"
                          title={`${room}号室に入居者を登録`}
                          className="p-3 bg-purple-50 hover:bg-purple-100 rounded-xl text-[10px] text-purple-300 hover:text-purple-500 text-center flex flex-col items-center justify-center border border-dashed border-purple-200 cursor-pointer transition-all min-h-[64px]"
                        >
                          <span>{room}</span>
                          <span>(空室)</span>
                          <span className="no-print font-bold mt-0.5">＋登録</span>
                        </div>
                      );
                    }
                    // 🩵 心マ・呼吸器・救急搬送のいずれかにチェックがあれば、部屋全体を薄い青色で強調する
                    const isCriticalAlert = p.cpr || p.respirator || p.emergencyTransport;
                    const cardColorClass = isCriticalAlert
                      ? 'bg-sky-100 border-sky-300 hover:bg-sky-200'
                      : 'bg-[#f3f0ff] border-purple-200 hover:bg-[#ebe5ff]';

                    return (
                      <div
                        key={room}
                        onDoubleClick={() => handleOpenEmergencyModal(p)}
                        title="ダブルクリックで緊急時対応サマリーシートを表示"
                        className={`p-3 rounded-2xl border shadow-sm transition-all relative cursor-pointer ${cardColorClass}`}
                      >
                        <button
                          onClick={() => handleVacateRoom(p.id, `${p.room} ${p.name}`)}
                          className="no-print absolute top-1 right-1 text-[9px] text-purple-300 hover:text-rose-500 font-bold px-1"
                          title="退去（空室に戻す）"
                        >
                          ✕
                        </button>
                        <div
                          onClick={(e) => { e.stopPropagation(); handleOpenTimeline(p.id); }}
                          onDoubleClick={(e) => e.stopPropagation()}
                          title="クリックして時系列（既往歴）を見る"
                          className={`no-print font-bold text-sm mb-2 cursor-pointer hover:underline inline-flex items-center gap-1 ${getNameColorClass(p.gender)}`}
                        >
                          {p.room} {p.name}<LastEditedHint p={p} /><span className="text-[9px] opacity-50">📜</span>
                        </div>
                        <div className={`print-only font-bold text-sm mb-2 ${getNameColorClass(p.gender)}`}>{p.room} {p.name}</div>
                        {/* 蘇生拒否/施設内看取り・胃ろう/CVポート・酸素/点滴 の3列レイアウト */}
                        {/* 🔒 どれか1つをクリックすると、ここで直接は切り替えず、この入居者1人分の項目一覧を開く */}
                        <div className="grid grid-cols-3 gap-x-1 gap-y-1 text-[9px] text-slate-700">
                          <label className="flex items-center"><input type="checkbox" checked={p.dnr} onChange={() => handleOpenMapCheckboxEditor(p.id)} className="mr-1 scale-75" /> 蘇生拒否</label>
                          <label className="flex items-center"><input type="checkbox" checked={p.gtube} onChange={() => handleOpenMapCheckboxEditor(p.id)} className="mr-1 scale-75" /> 胃ろう</label>
                          <label className="flex items-center"><input type="checkbox" checked={p.oxygen} onChange={() => handleOpenMapCheckboxEditor(p.id)} className="mr-1 scale-75" /> 酸素</label>
                          <label className="flex items-center"><input type="checkbox" checked={p.facilityEndofLife} onChange={() => handleOpenMapCheckboxEditor(p.id)} className="mr-1 scale-75" /> 施設内看取り</label>
                          <label className="flex items-center"><input type="checkbox" checked={p.cvport} onChange={() => handleOpenMapCheckboxEditor(p.id)} className="mr-1 scale-75" /> CVポート</label>
                          <label className="flex items-center"><input type="checkbox" checked={p.ivDrip} onChange={() => handleOpenMapCheckboxEditor(p.id)} className="mr-1 scale-75" /> 点滴</label>
                        </div>
                        <div className={`mt-2 pt-2 border-t border-dashed ${isCriticalAlert ? 'border-sky-300' : 'border-purple-200'}`}>
                          <div className="flex flex-wrap gap-x-2 gap-y-1 text-[8px]">
                            <label className="flex items-center"><input type="checkbox" checked={p.cpr} onChange={() => handleOpenMapCheckboxEditor(p.id)} className="mr-0.5 scale-75" /> 心マ</label>
                            <label className="flex items-center"><input type="checkbox" checked={p.respirator} onChange={() => handleOpenMapCheckboxEditor(p.id)} className="mr-0.5 scale-75" /> 呼吸器</label>
                            <label className={`flex items-center font-bold ${p.emergencyTransport ? 'text-red-600' : ''}`}><input type="checkbox" checked={p.emergencyTransport} onChange={() => handleOpenMapCheckboxEditor(p.id)} className="mr-0.5 scale-75" /> 救急搬送</label>
                          </div>
                        </div>

                        {/* 📎 スキャン・添付書類：ダブルクリックで閲覧できる */}
                        <div className="no-print mt-2 pt-2 border-t border-dashed border-purple-200" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
                          <div className="flex flex-wrap items-center gap-1">
                            {p.attachedFiles.map(f => (
                              <div
                                key={f.id}
                                onDoubleClick={() => setViewingAttachedFile(f)}
                                title={`ダブルクリックで閲覧：${f.name}`}
                                className="relative group/att w-8 h-8 rounded-lg border border-purple-200 bg-white overflow-hidden cursor-pointer flex items-center justify-center shrink-0"
                              >
                                {f.type === 'image' ? (
                                  <img src={f.dataUrl} alt={f.name} className="w-full h-full object-cover" />
                                ) : (
                                  <span className="text-sm">{f.type === 'video' ? '🎞️' : '📄'}</span>
                                )}
                                <button
                                  type="button"
                                  onClick={ev => { ev.stopPropagation(); if (window.confirm(`「${f.name}」を削除しますか？`)) handleRemoveAttachedFile(p.id, f.id); }}
                                  title="削除"
                                  className="absolute -top-1 -right-1 opacity-0 group-hover/att:opacity-100 transition-opacity bg-white rounded-full text-[9px] text-slate-400 hover:text-rose-500 font-bold w-3.5 h-3.5 leading-none border border-slate-200"
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                            <label
                              title="書類をスキャン・添付（カメラ撮影またはファイル選択）"
                              className="w-8 h-8 rounded-lg border border-dashed border-purple-300 text-purple-400 hover:text-purple-600 hover:border-purple-400 flex items-center justify-center cursor-pointer text-sm shrink-0"
                            >
                              📎
                              <input
                                type="file"
                                accept="image/*,application/pdf"
                                capture="environment"
                                multiple
                                onChange={e => { handleAttachFiles(p.id, e.target.files); e.target.value = ''; }}
                                className="hidden"
                              />
                            </label>
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 画面[1]: 業務連絡 */}
      {currentView === 'handover' && (
        <div className={`max-w-3xl mx-auto px-4 py-6 ${hideMainViewForPrint ? 'no-print' : ''}`}>
          <div className="bg-[#fefaf4] rounded-2xl border-2 border-amber-300 p-4 shadow-md">
            <div className="flex justify-between items-center mb-1.5 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <div className="font-bold text-sm text-purple-800 flex items-center gap-1">📢 業務連絡シート</div>
                {/* 📜 業務連絡シートの日付ごとの履歴：保存するたびに記録され、▼から過去の日の内容を見返せる */}
                <div className="no-print relative group inline-block text-xs">
                  <button
                    type="button"
                    data-history-toggle
                    onClick={() => setOpenHistoryMenu(prev => prev === 'handover' ? null : 'handover')}
                    className="font-bold text-slate-500 px-2 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 inline-flex items-center gap-1"
                  >
                    履歴 <span className="text-[9px]">▼</span>
                  </button>
                  <div data-history-menu className={`${openHistoryMenu === 'handover' ? 'block' : 'hidden group-hover:block'} absolute left-0 top-full z-30 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[8rem]`}>
                    {Object.keys(handoverNoteArchive).length === 0 && (
                      <div className="px-3 py-2 text-slate-400 font-bold whitespace-nowrap">記録はまだありません</div>
                    )}
                    {Object.keys(handoverNoteArchive).sort().reverse().map(date => (
                      <div key={date} className="flex items-center justify-between hover:bg-slate-50">
                        <button
                          type="button"
                          onClick={() => { setViewingHandoverArchiveDate(date); setOpenHistoryMenu(null); }}
                          className="flex-1 text-left px-3 py-1.5 text-slate-600 font-bold whitespace-nowrap"
                        >
                          {formatISOToJapaneseDate(date)}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`${formatISOToJapaneseDate(date)}の履歴を削除します。よろしいですか？`)) {
                              setHandoverNoteArchive(prev => {
                                const next = { ...prev };
                                delete next[date];
                                if (typeof window !== 'undefined') localStorage.setItem('oncall_handover_note_archive', JSON.stringify(next));
                                return next;
                              });
                              if (viewingHandoverArchiveDate === date) setViewingHandoverArchiveDate(null);
                            }
                          }}
                          className="px-2 py-1.5 text-rose-500 hover:text-rose-700 font-bold"
                          title="この履歴を削除"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              {/* 📅 業務連絡シートの「作成する日にち」：カレンダーで選び直せる。右上の🗓️（ログインした日）とは別物 */}
              <div className="no-print relative flex items-center gap-1">
                <span className="text-xs font-bold text-amber-700 whitespace-nowrap">作成日：</span>
                <button
                  type="button"
                  onClick={openHandoverDateCalendar}
                  className="text-xs font-bold text-amber-700 whitespace-nowrap px-2 py-1 rounded-lg border border-amber-200 bg-white hover:bg-amber-50"
                >
                  🗓️ {formatISOToJapaneseDate(handoverCreationDate) || '未設定'}
                </button>
                {isHandoverDateCalendarOpen && (
                  <div className="absolute left-0 top-full mt-1 z-30 bg-white border border-amber-200 rounded-xl shadow-lg p-2 w-56">
                    <div className="flex items-center justify-between mb-1.5">
                      <button type="button" onClick={() => shiftHandoverDateCalendarMonth(-1)} className="w-7 h-7 rounded-lg border border-amber-200 bg-white hover:bg-amber-50 text-xs font-bold">◀</button>
                      <div className="text-xs font-bold text-amber-900">
                        {(() => {
                          const [y, m] = (handoverDateCalendarViewMonth || getTodayISO().slice(0, 7)).split('-');
                          return `${y}年${Number(m)}月`;
                        })()}
                      </div>
                      <button type="button" onClick={() => shiftHandoverDateCalendarMonth(1)} className="w-7 h-7 rounded-lg border border-amber-200 bg-white hover:bg-amber-50 text-xs font-bold">▶</button>
                    </div>
                    <div className="grid grid-cols-7 gap-0.5 text-center">
                      {JST_WEEKDAYS.map(w => (
                        <div key={w} className="text-[9px] font-bold text-slate-400">{w}</div>
                      ))}
                      {getCalendarMonthCells(handoverDateCalendarViewMonth || getTodayISO().slice(0, 7)).map((iso, idx) => {
                        if (!iso) return <div key={idx} />;
                        const isSelected = handoverCreationDate === iso;
                        const isToday = getTodayISO() === iso;
                        const isDisabled = iso > getHandoverMaxDate();
                        return (
                          <button
                            key={iso}
                            type="button"
                            disabled={isDisabled}
                            onClick={() => handleSelectHandoverDate(iso)}
                            title={isDisabled ? 'ログインした日の翌日より先は選べません' : undefined}
                            className={`w-6 h-6 rounded text-[10px] font-bold flex items-center justify-center ${isDisabled ? 'text-slate-300 cursor-not-allowed' : isSelected ? 'bg-amber-600 text-white' : isToday ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'hover:bg-amber-50 text-slate-700'}`}
                          >
                            {Number(iso.slice(8, 10))}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              <span className="print-only text-xs font-bold text-amber-700 whitespace-nowrap">作成日：{formatISOToJapaneseDate(handoverCreationDate)}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSaveHandoverNote}
                  disabled={handoverNote === savedHandoverNote}
                  className="no-print bg-amber-600 hover:bg-amber-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white px-4 py-1.5 rounded-xl font-bold text-xs"
                >
                  💾 保存
                </button>
                {/* 🖨️ 未来日（まだ来ていない翌日）の間は印刷マーク自体を出さない。その日になったら表出する */}
                {handoverCreationDate <= getTodayISO() && (
                  <button onClick={() => window.print()} className="no-print bg-[#fdf0f0] text-pink-700 border px-4 py-1.5 rounded-xl font-bold text-xs">🖨️</button>
                )}
                <button onClick={handleUndoLastPatientsChange} className="no-print bg-[#fdf0f0] text-pink-700 border px-4 py-1.5 rounded-xl font-bold text-xs" title="直前の編集を1件取り消します">↩️ 元に戻す</button>
              </div>
            </div>
            <textarea
              value={handoverNote}
              onChange={(e) => setHandoverNote(e.target.value)}
              rows={20}
              placeholder={handoverCreationDate > getTodayISO() ? DEFAULT_HANDOVER_NOTE_FUTURE : undefined}
              className={`no-print w-full p-3 border border-amber-200 rounded-xl text-sm bg-white resize-y placeholder:text-slate-400 ${isHandoverNoteFutureGray ? 'text-slate-400' : ''}`}
            />
            <div className={`print-only whitespace-pre-wrap text-sm p-3 border border-amber-200 rounded-xl bg-white ${isHandoverNoteFutureGray ? 'text-slate-400 handover-note-pending-print' : ''}`}>{handoverNote}</div>
            <div className="no-print text-[10px] text-amber-700/70 mt-2">
              {handoverNoteSavedAt ? (
                <>📅 最終保存：<span className="font-bold">{handoverNoteSavedAt}</span>　👤 {handoverNoteSavedBy || '不明なユーザー'}</>
              ) : (
                <>まだ保存されていません</>
              )}
              {handoverNote !== savedHandoverNote && (
                <span className="ml-2 text-rose-600 font-bold">⚠️ 未保存の変更があります</span>
              )}
            </div>
          </div>
          <div className="no-print flex justify-between items-center mt-1">
            <button
              type="button"
              onClick={() => {
                if (window.confirm('この画面の操作を削除しますか？')) {
                  setHandoverNote('');
                  setSavedHandoverNote('');
                  setHandoverNoteSavedBy('');
                  setHandoverNoteSavedAt('');
                  if (typeof window !== 'undefined') {
                    localStorage.setItem('oncall_handover_note', '');
                    localStorage.setItem('oncall_handover_note_saved_by', '');
                    localStorage.setItem('oncall_handover_note_saved_at', '');
                  }
                }
              }}
              className="text-xs font-bold text-rose-600 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-xl px-3 py-1.5"
            >
              🗑️ 削除
            </button>
            <span className="text-right text-xs font-bold text-amber-700 whitespace-nowrap">{todayLabel}</span>
          </div>
        </div>
      )}

      {/* 📜 業務連絡シートの履歴：過去の日の内容を読み取り専用で表示するモーダル。印刷・削除もできる。
          currentView==='handover'のno-print切り替えの外（トップレベル）に置くことで、印刷時に
          自分自身が巻き添えでno-printになって消えてしまわないようにしている */}
      {viewingHandoverArchiveDate && (
        <div className="modal-print-wrap fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="modal-print-panel print-container bg-white rounded-3xl border border-amber-200 shadow-2xl w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
            <div className="bg-amber-700 p-4 text-white flex justify-between items-center shrink-0">
              <div className="text-sm font-bold">{formatISOToJapaneseDate(viewingHandoverArchiveDate)}の業務連絡（履歴）</div>
              <div className="no-print flex items-center gap-2">
                {/* 🖨️ 履歴から未来日（まだ来ていない翌日）を開いた時は印刷マーク自体を出さない。その日になったら表出する */}
                {viewingHandoverArchiveDate && viewingHandoverArchiveDate <= getTodayISO() && (
                  <button
                    type="button"
                    onClick={() => window.print()}
                    className="text-xs font-bold bg-white/15 hover:bg-white/25 border border-white/30 rounded-lg px-2.5 py-1.5 whitespace-nowrap"
                    title="この履歴を印刷"
                  >
                    🖨️
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const date = viewingHandoverArchiveDate;
                    if (window.confirm(`${formatISOToJapaneseDate(date)}の履歴を削除します。よろしいですか？`)) {
                      setHandoverNoteArchive(prev => {
                        const next = { ...prev };
                        delete next[date];
                        if (typeof window !== 'undefined') localStorage.setItem('oncall_handover_note_archive', JSON.stringify(next));
                        return next;
                      });
                      setViewingHandoverArchiveDate(null);
                    }
                  }}
                  className="text-xs font-bold bg-rose-500/80 hover:bg-rose-500 border border-rose-300 rounded-lg px-2.5 py-1.5 whitespace-nowrap"
                  title="この履歴を削除"
                >
                  × 削除
                </button>
                <button type="button" onClick={() => setViewingHandoverArchiveDate(null)} className="text-2xl font-normal hover:text-amber-200 leading-none">✕</button>
              </div>
            </div>
            <div className="modal-print-scroll p-4 overflow-y-auto">
              <div className="text-[10px] text-amber-700/70 mb-2">
                📅 保存日時：<span className="font-bold">{handoverNoteArchive[viewingHandoverArchiveDate]?.savedAt || '不明'}</span>　👤 {handoverNoteArchive[viewingHandoverArchiveDate]?.savedBy || '不明なユーザー'}
              </div>
              <div className="whitespace-pre-wrap text-sm p-3 border border-amber-200 rounded-xl bg-white">
                {handoverNoteArchive[viewingHandoverArchiveDate]?.text}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ✅ 業務連絡シート：未来日向けに保存した内容が「今日」になった時、確定するかどうかを確認するモーダル。
          currentViewに関わらず、ログイン直後にどの画面を開いていても表出させたいのでトップレベルに置く */}
      {isHandoverConfirmPromptOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl border border-amber-200 shadow-2xl w-full max-w-sm p-5">
            <div className="text-sm font-bold text-amber-800 mb-2">📢 業務連絡シートの確認</div>
            <div className="text-sm text-slate-700 mb-3">
              {formatISOToJapaneseDate(savedHandoverNoteDate)}向けに、すでに入力された内容があります。この内容を確定しますか？
            </div>
            <div className="whitespace-pre-wrap text-sm p-3 border border-amber-200 rounded-xl bg-amber-50 text-slate-500 mb-4 max-h-40 overflow-y-auto">
              {savedHandoverNote}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={handleRejectHandoverNote} className="text-xs font-bold text-rose-600 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-xl px-4 py-2">いいえ（削除）</button>
              <button type="button" onClick={handleConfirmHandoverNote} className="text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 rounded-xl px-4 py-2">はい（確定）</button>
            </div>
          </div>
        </div>
      )}

      {/* 画面[2]: 診察指示テーブル */}
      {currentView === 'doctor' && (
        <div className={`print-container w-full px-4 py-6 space-y-4 ${hideMainViewForPrint ? 'no-print' : ''}`}>
          <div className="max-w-7xl mx-auto flex justify-between items-center flex-wrap gap-2 no-print bg-white p-3 rounded-2xl border border-pink-100 shadow-sm">
            <div>
              <span className="text-xs font-bold text-amber-900">🌸 VS・医師連携</span>
              {/* 🗓️ 診療日：次回往診サイクル開始で自動的に2週間後の日付が入る。クリックしてボタンで日付を選択・保存 */}
              <div className="flex items-center gap-1.5 mt-1.5">
                <span className="text-xs font-bold text-amber-900">🗓️ 診療日：</span>
                <button
                  type="button"
                  onClick={openVisitDateEditor}
                  className="text-xs font-bold border border-pink-200 rounded-lg px-2 py-1 w-40 bg-[#fdf5f5] hover:bg-pink-50 cursor-pointer whitespace-nowrap overflow-hidden text-ellipsis text-left"
                >
                  {nextVisitDate || '未設定'}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex flex-col gap-1.5">
                <button onClick={handleSaveDoctorScreen} className={`no-print text-white px-4 py-1.5 rounded-xl font-bold text-xs ${hasDoctorScreenChanges ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-slate-300'}`}>💾 保存</button>
                <button onClick={() => window.print()} className="bg-[#fdf0f0] text-pink-700 border px-4 py-1.5 rounded-xl font-bold text-xs">🖨️</button>
                <button onClick={handlePrintVsOnly} className="bg-pink-600 hover:bg-pink-700 text-white px-4 py-1.5 rounded-xl font-bold text-xs">🖨️ VS</button>
              </div>
            </div>
          </div>

          {/* 📋 往診記録アーカイブ：「履歴▼」を画面左下に固定表示するフローティングボタンにし、開くとその上に
              一覧パネルが浮かび上がる。未来日に向けて準備中のVS・医師連携（薄いピンク）とは見た目で区別できるよう、
              履歴側は薄いグレイにする。「次回に更新」はナビバーから移動し、この「履歴▼」の右手に並べる */}
          <div className="fixed bottom-4 left-4 z-40 no-print flex items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsDoctorVisitHistoryOpen(prev => !prev)}
              className="flex items-center gap-1.5 bg-white hover:bg-slate-50 border border-slate-300 shadow-lg rounded-full px-4 py-2.5 text-xs font-bold text-amber-900"
            >
              📜 履歴
              <span className={`text-slate-400 text-xs transition-transform ${isDoctorVisitHistoryOpen ? 'rotate-180' : ''}`}>▼</span>
            </button>
            {isDoctorVisitHistoryOpen && (
            <div className="absolute bottom-full left-0 mb-2 bg-white rounded-2xl border border-slate-200 shadow-xl w-[92vw] max-w-2xl max-h-[70vh] overflow-y-auto">
            {(() => {
              // 📋 往診記録を「次回往診サイクル開始」を押した1回ごと（timestampが同一な一群）にまとめる。
              // 同じ日付の文字列だけでグループ化すると、同じ日に2回以上サイクルを開始した場合に
              // 別々の回の記録が1つのグループへ混ざってしまい、どちらの回の記録か分からなくなるため、
              // 全入居者で共通の実行時刻（timestamp）を使って、実行1回＝1グループに厳密に分ける
              type VisitGroup = { date: string; timestamp: number; entries: { patient: Patient; record: VisitRecord }[] };
              const groups: VisitGroup[] = [];
              patients.forEach(patient => {
                patient.visitHistory.forEach(record => {
                  let group = groups.find(g => g.timestamp === record.timestamp);
                  if (!group) {
                    group = { date: record.date, timestamp: record.timestamp, entries: [] };
                    groups.push(group);
                  }
                  group.entries.push({ patient, record });
                });
              });
              groups.sort((a, b) => b.timestamp - a.timestamp);

              // 📋 同じ日付のグループが複数あるかどうか（表示に時刻を添えるかどうかの判定に使う）
              const dateOccurrences = groups.reduce<Record<string, number>>((acc, g) => {
                acc[g.date] = (acc[g.date] || 0) + 1;
                return acc;
              }, {});

              if (groups.length === 0) {
                return <p className="text-sm text-slate-400 text-center py-6 border-t border-slate-100">まだ往診記録はありません。「📅 次回に更新」を押すと、その時点の記録がここに保存されます。</p>;
              }

              return (
                <div className="space-y-2 p-3 border-t border-slate-100">
                  {groups.map(group => {
                    const groupKey = String(group.timestamp);
                    const isOpen = !!expandedVisitDates[groupKey];
                    // 🈂️ 同じ日付で2回以上サイクルを開始している場合だけ、区別できるよう時刻も表示する
                    const timeLabel = dateOccurrences[group.date] > 1
                      ? ` ${new Date(group.timestamp).getHours()}:${String(new Date(group.timestamp).getMinutes()).padStart(2, '0')}`
                      : '';
                    return (
                      <div key={groupKey} className="border border-slate-200 rounded-2xl overflow-hidden">
                        {/* 📅 タイトル（日付・複数回開始した日は時刻も）の行：タップで開閉。右端の×で削除（管理者PW必須） */}
                        <div className="w-full flex items-center px-3 py-2.5 bg-white">
                          <button
                            type="button"
                            onClick={() => toggleVisitDateExpand(groupKey)}
                            className="flex-1 min-w-0 flex items-center justify-between text-left hover:bg-slate-50 transition-colors"
                          >
                            <span className="font-bold text-sm text-slate-700">📅 {group.date}{timeLabel}（{group.entries.length}名分の記録）</span>
                            <span className={`text-slate-400 text-xs transition-transform ${isOpen ? 'rotate-180' : ''}`}>▼</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteVisitArchiveGroup(`${group.date}${timeLabel}`, group.timestamp)}
                            className="no-print shrink-0 ml-2 text-slate-300 hover:text-rose-500 font-bold text-sm px-1 leading-none"
                            title="この日の記録を削除"
                          >
                            ×
                          </button>
                        </div>

                        {/* 開いた時だけ、その日の全員分の記録を表示。🌸 VS・医師連携画面と同じ表形式で表示する */}
                        {isOpen && (
                          <div className="overflow-x-auto bg-slate-100">
                            <table className="w-full text-left text-xs border-collapse">
                              <thead className="bg-slate-200 text-slate-700 font-bold border-b border-slate-300">
                                <tr>
                                  <th className="p-2 w-40">氏名</th>
                                  <th className="p-2 w-1/5 bg-slate-200/60 border-r-2 border-slate-300">状態報告</th>
                                  <th className="p-2 w-1/5 border-r-2 border-slate-300">医師指示</th>
                                  <th className="p-2 w-2/5 bg-slate-200/60">指示内容 ／ 日/期間</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y-2 divide-slate-200 bg-slate-50">
                                {group.entries.map(({ patient, record: v }) => {
                                  const isEditing = editingArchiveRecordId === v.id;
                                  const d = isEditing ? archiveRecordDraft : null;
                                  return (
                                  <tr key={v.id}>
                                    <td className="p-2 border-r align-top space-y-2">
                                      <div className="flex items-start justify-between gap-1">
                                        <div className={`font-bold text-sm ${getNameColorClass(patient.gender)}`}>{patient.room} {patient.name}</div>
                                        {!isEditing && (
                                          <ArchiveEditBadge record={v} onClick={() => handleStartEditArchiveRecord(v)} />
                                        )}
                                      </div>
                                      {isEditing && d ? (
                                        <div className="w-full bg-slate-50 p-1.5 rounded-xl border border-slate-200/70 space-y-1">
                                          {(['kt', 'bp', 'spo2', 'p'] as const).map(field => (
                                            <div key={field} className="flex items-center gap-1">
                                              <span className="text-[9px] text-slate-400 w-8 shrink-0 uppercase">{field}</span>
                                              <input
                                                type="text"
                                                value={d[field]}
                                                onChange={e => setArchiveRecordDraft(prev => prev ? { ...prev, [field]: e.target.value } : prev)}
                                                className="w-full text-[10px] font-mono px-1 py-0.5 border border-slate-300 rounded bg-white"
                                              />
                                            </div>
                                          ))}
                                        </div>
                                      ) : (
                                        <div className="w-full bg-slate-50 p-1.5 rounded-xl border border-slate-200/70 space-y-1">
                                          <div className="text-[10px] font-mono">KT: {v.kt || '－'}</div>
                                          <div className="text-[10px] font-mono">BP: {v.bp || '－'}</div>
                                          <div className="text-[10px] font-mono">SpO2: {v.spo2 || '－'}</div>
                                          <div className="text-[10px] font-mono">P: {v.p || '－'}</div>
                                        </div>
                                      )}
                                    </td>
                                    <td className="p-2 border-r-2 border-slate-200 align-top whitespace-pre-wrap">
                                      {isEditing && d ? (
                                        <textarea
                                          value={d.reportToDoctor}
                                          onChange={e => setArchiveRecordDraft(prev => prev ? { ...prev, reportToDoctor: e.target.value } : prev)}
                                          rows={4}
                                          className="w-full p-1 border border-slate-300 rounded-lg bg-white text-xs"
                                        />
                                      ) : v.reportToDoctor}
                                    </td>
                                    <td className="p-2 border-r-2 border-slate-200 align-top whitespace-pre-wrap">
                                      {isEditing && d ? (
                                        <textarea
                                          value={d.doctorMemo}
                                          onChange={e => setArchiveRecordDraft(prev => prev ? { ...prev, doctorMemo: e.target.value } : prev)}
                                          rows={4}
                                          className="w-full p-1 border border-slate-300 rounded-lg bg-white text-xs"
                                        />
                                      ) : v.doctorMemo}
                                    </td>
                                    <td className="p-2 bg-slate-100 align-top space-y-2">
                                      {isEditing && d ? (
                                        <>
                                          <div className="space-y-1">
                                            {d.doctorOrder.split('\n').map((line, idx) => {
                                              if (line.trim() === '') return null;
                                              const status = d.orderStatus[idx] || { checked: false };
                                              const periodText = formatOrderPeriod(d.orderPeriods[idx]);
                                              return (
                                                <div key={idx} className="flex items-start gap-1 p-1.5 rounded-lg border border-slate-200 bg-white">
                                                  <button
                                                    type="button"
                                                    onClick={() => handleArchiveDraftToggleOrderChecked(idx)}
                                                    className={`shrink-0 w-4 h-4 mt-0.5 rounded border flex items-center justify-center text-[10px] ${status.checked ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white border-slate-300'}`}
                                                  >
                                                    ✓
                                                  </button>
                                                  <input
                                                    type="text"
                                                    value={line}
                                                    onChange={e => handleArchiveDraftChangeOrderLine(idx, e.target.value)}
                                                    className="flex-1 min-w-0 text-xs px-1 py-0.5 border border-slate-200 rounded bg-white"
                                                  />
                                                  <input
                                                    type="text"
                                                    value={periodText === '未設定' ? '' : periodText}
                                                    onChange={e => handleArchiveDraftChangePeriodText(idx, e.target.value)}
                                                    placeholder="日/期間"
                                                    className="w-20 shrink-0 text-[9px] font-mono px-1 py-0.5 border border-slate-200 rounded bg-white"
                                                  />
                                                  <button
                                                    type="button"
                                                    onClick={() => handleArchiveDraftDeleteOrderLine(idx)}
                                                    className="shrink-0 text-slate-300 hover:text-rose-500 font-bold text-sm px-1 leading-none"
                                                  >
                                                    ×
                                                  </button>
                                                </div>
                                              );
                                            })}
                                          </div>
                                          <div className="flex items-center gap-1">
                                            <input
                                              type="text"
                                              value={archiveManualOrderInput}
                                              onChange={e => setArchiveManualOrderInput(e.target.value)}
                                              onKeyDown={e => {
                                                if (e.key === 'Enter') {
                                                  handleArchiveDraftAddOrderLine(archiveManualOrderInput);
                                                  setArchiveManualOrderInput('');
                                                }
                                              }}
                                              placeholder="指示を追加（Enterで追加）"
                                              className="flex-1 min-w-0 text-xs px-1.5 py-1 border border-slate-200 rounded-lg bg-white"
                                            />
                                            <button
                                              type="button"
                                              onClick={() => { handleArchiveDraftAddOrderLine(archiveManualOrderInput); setArchiveManualOrderInput(''); }}
                                              className="shrink-0 text-[10px] bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded-lg px-2 py-1 font-bold"
                                            >
                                              ＋追加
                                            </button>
                                          </div>
                                          <div className="flex items-center gap-2 pt-1">
                                            <button
                                              type="button"
                                              onClick={() => handleSaveEditArchiveRecord(patient.id)}
                                              className="text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg px-3 py-1.5"
                                            >
                                              💾 保存
                                            </button>
                                            <button
                                              type="button"
                                              onClick={handleCancelEditArchiveRecord}
                                              className="text-xs font-bold text-slate-500 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg px-3 py-1.5"
                                            >
                                              キャンセル
                                            </button>
                                          </div>
                                        </>
                                      ) : (
                                        <>
                                          <div className="space-y-1">
                                            {v.doctorOrder.split('\n').filter(l => l.trim() !== '').map((line, idx) => {
                                              const status = v.orderStatus[idx] || { checked: false };
                                              const createdBy = v.orderCreatedBy[idx];
                                              const periodText = formatOrderPeriod(v.orderPeriods[idx]);
                                              return (
                                                <div
                                                  key={idx}
                                                  className={`flex items-start gap-2 p-1.5 rounded-lg border ${status.checked ? 'bg-emerald-50 border-emerald-200 text-slate-400 line-through' : 'bg-white border-slate-200 font-bold text-slate-800'}`}
                                                >
                                                  <span className="shrink-0">{status.checked ? '✅' : '☐'}</span>
                                                  <span className="flex-1 break-words">{line}</span>
                                                  <span className="shrink-0 text-[9px] font-mono whitespace-nowrap no-line-through">{periodText !== '未設定' ? `🗓️${periodText}` : ''} {createdBy ? `✏️${createdBy}` : ''} {status.checked && status.Sign ? status.Sign : ''}</span>
                                                </div>
                                              );
                                            })}
                                          </div>
                                          {v.suppliesUsedSnapshot.length > 0 && (
                                            <div>
                                              <span className="font-bold text-slate-500">📦 物品使用数：</span>
                                              {v.suppliesUsedSnapshot.map((s, i) => (
                                                <span key={i} className="inline-block bg-amber-50 text-amber-800 rounded px-1.5 py-0.5 ml-1">{s.name}：{s.used}</span>
                                              ))}
                                            </div>
                                          )}
                                        </>
                                      )}
                                    </td>
                                  </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })()}
            </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleStartNextVisitCycle}
            title="2週間ごとの定期往診に合わせて、バイタル・指示カルテ・観察要点・物品使用数をリセットします"
            className="bg-indigo-50 hover:bg-indigo-600 text-amber-900 hover:text-white border border-indigo-200 shadow-lg rounded-full px-4 py-2.5 text-xs font-bold whitespace-nowrap"
          >
            📅 次回に更新
          </button>
          </div>

          <div className="max-w-7xl mx-auto no-print text-right text-xs font-bold text-pink-700 whitespace-nowrap -mt-1">{todayLabel}</div>

          {/* 🖨️ VSのみ印刷：②VS・状態報告・医師指示だけをクリニック宛の簡易帳票として印刷する */}
          <div className="max-w-7xl mx-auto flex items-center gap-3 flex-wrap no-print bg-white p-3 rounded-2xl border border-pink-100 shadow-sm">
            <span className="text-xs font-bold text-amber-900 whitespace-nowrap">🖨️ 担当医療機関：</span>
            <div className="relative flex-1 min-w-[12rem] max-w-md">
              <input
                type="text"
                value={clinicName}
                onChange={e => setClinicName(e.target.value)}
                onFocus={() => setIsClinicHistoryOpen(true)}
                onBlur={() => { handleClinicNameBlur(); setIsClinicHistoryOpen(false); }}
                placeholder="クリニック名を入力（クリックすると入力履歴から選択できます）"
                title="クリックすると、これまでに入力したクリニック名の履歴から選べます"
                className="w-full p-1.5 border border-pink-200 rounded-lg text-xs"
              />
              {isClinicHistoryOpen && clinicNameHistory.length > 0 && (
                <div className="absolute z-20 mt-1 bg-white border border-pink-200 rounded-lg shadow-lg w-full max-h-48 overflow-y-auto">
                  {sortByGuessedReading(clinicNameHistory, n => n).map(name => (
                    <div key={name} className="flex items-center hover:bg-pink-50">
                      <button
                        type="button"
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => { setClinicName(name); setIsClinicHistoryOpen(false); }}
                        className="flex-1 min-w-0 text-left px-3 py-1.5 text-xs text-slate-700"
                      >
                        {name}
                      </button>
                      <button
                        type="button"
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => {
                          if (window.confirm('この履歴を削除します。よろしいですか？')) handleDeleteClinicNameHistory(name);
                        }}
                        className="shrink-0 text-slate-300 hover:text-rose-500 font-bold text-sm leading-none px-2"
                        title="この履歴を削除"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 🖨️ 全体印刷時（VSのみ印刷ではなく🖨️ボタンでの印刷）にも、診療日・担当医療機関名が紙面に残るよう表示する
             （VSのみ印刷は専用のレイアウト側ですでに表示しているため、二重に出ないようここでは除外する） */}
          {!isVsPrintMode && (
            <div className="print-only max-w-7xl mx-auto text-xs font-bold text-slate-700 flex gap-4 -mb-2">
              <span>🗓️ 診療日：{nextVisitDate || '未設定'}</span>
              <span>🏥 担当医療機関：{clinicName || '未設定'}</span>
            </div>
          )}

          {isVsPrintMode ? (
            <div className="max-w-3xl mx-auto bg-white p-8 space-y-4">
              <div className="flex justify-between items-start border-b-2 border-pink-200 pb-3 mb-3">
                <div className="text-lg font-bold text-pink-900">{clinicName ? `${clinicName} 御中` : 'クリニック 御中'}</div>
                <div className="text-right text-xs text-slate-500 whitespace-nowrap">
                  <div>診療日：{nextVisitDate || '未設定'}</div>
                  <div>印刷日：{todayLabel}</div>
                </div>
              </div>
              <div className="text-sm font-bold text-pink-900 mb-2">VS</div>
              {/* 🈂️ バイタルが1つも入力されていない人は、報告することが無いとみなして氏名ごと印刷から省く */}
              {patients.filter(p => p.kt || p.bp || p.spo2 || p.p).map(p => (
                <div key={p.id} className="border-b border-slate-200 pb-3 print-page-break">
                  <div className="font-bold text-sm mb-1">{p.room} {p.name}</div>
                  <div className="flex gap-4 text-xs font-mono text-slate-700">
                    <span>KT: {p.kt || '－'}</span>
                    <span>BP: {p.bp || '－'}</span>
                    <span>SpO2: {p.spo2 || '－'}</span>
                    <span>P: {p.p || '－'}</span>
                  </div>
                </div>
              ))}
              {patients.every(p => !p.kt && !p.bp && !p.spo2 && !p.p) && (
                <div className="text-xs text-slate-400 text-center py-6">バイタルが入力されている方がいません。</div>
              )}
            </div>
          ) : (
          <div className="bg-white rounded-2xl border border-slate-100 shadow-md overflow-visible max-w-7xl mx-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-[#fdf5f5] text-pink-900 font-bold border-b">
                <tr>
                  <th className="p-3 w-44">氏名</th>
                  <th className="p-3 w-1/5 bg-[#fbf5f5] border-r-2 border-pink-200">状態報告</th>
                  <th className="p-3 w-1/5 border-r-2 border-pink-200">医師指示</th>
                  <th className="p-3 w-2/5 bg-[#fbf5f5]">指示内容 ／ 日/期間</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-pink-200">
                {patients.map(p => (
                  <tr key={p.id} className="print-page-break hover:bg-[#fffdfd]">
                    <td className="p-3 space-y-2 border-r valign-top">
                      <div className={`font-bold text-sm ${getNameColorClass(p.gender)}`}>{p.room} {p.name}<LastEditedHint p={p} /></div>
                      
                      {/* 🩺 数値ボックス：タップするとテンキーでVSを入力できます（1.バイタル画面は廃止し、こちらに統合） */}
                      <div className="w-full bg-slate-50 p-1 rounded-xl border border-slate-200/70 shadow-inner space-y-px no-print">
                        <button type="button" onClick={() => openKeypad(p, 'kt', '体温 (KT)')} className={`w-full flex justify-center items-center px-1.5 py-0.5 rounded border text-[10px] font-mono h-5 cursor-pointer transition-all ${p.kt && isKtAlert(p.kt) ? 'text-rose-600 font-extrabold bg-rose-50/80 border-rose-200' : 'text-slate-700 bg-white border-slate-100 font-bold hover:bg-slate-50'}`}>
                          <span>{p.kt ? `${p.kt} ℃` : 'KT'}</span>
                        </button>
                        <button type="button" onClick={() => openKeypad(p, 'bp', '血圧 (BP)')} className={`w-full flex justify-center items-center px-1.5 py-0.5 rounded border text-[10px] font-mono h-5 cursor-pointer transition-all ${p.bp && isBpAlert(p.bp) ? 'font-extrabold bg-rose-50/80 border-rose-200' : 'text-slate-700 font-bold bg-white border-slate-100 hover:bg-slate-50'}`}>
                          {p.bp ? renderBpValue(p.bp) : <span>BP</span>}
                        </button>
                        <button type="button" onClick={() => openKeypad(p, 'spo2', '酸素飽和度 (SpO2)')} className={`w-full flex justify-center items-center px-1.5 py-0.5 rounded border text-[10px] font-mono h-5 cursor-pointer transition-all ${p.spo2 && isSpO2Alert(p.spo2) ? 'text-rose-600 font-extrabold bg-rose-50/80 border-rose-200' : 'text-slate-700 bg-white border-slate-100 font-bold hover:bg-slate-50'}`}>
                          <span>{p.spo2 ? `${p.spo2} %` : 'SpO2'}</span>
                        </button>
                        <button type="button" onClick={() => openKeypad(p, 'p', '脈拍 (P)')} className={`w-full flex justify-center items-center px-1.5 py-0.5 rounded border text-[10px] font-mono h-5 cursor-pointer transition-all ${p.p && isPAlert(p.p) ? 'text-rose-600 font-extrabold bg-rose-50/80 border-rose-200' : 'text-slate-700 bg-white border-slate-100 font-bold hover:bg-slate-50'}`}>
                          <span>{p.p ? `${p.p} 回` : 'P'}</span>
                        </button>
                      </div>
                      {/* 印刷時はボタンではなく静的な数値表示にする */}
                      <div className="hidden print:block w-full bg-slate-50 p-2 rounded-xl border border-slate-200/70 space-y-1">
                        <div className="text-xs font-mono">KT: {p.kt}</div>
                        <div className="text-xs font-mono">BP: {p.bp}</div>
                        <div className="text-xs font-mono">SpO2: {p.spo2}</div>
                        <div className="text-xs font-mono">P: {p.p}</div>
                      </div>
                    </td>

                    
                    {/* ① 状態報告 */}
                    <td className="p-2 space-y-1 border-r-2 border-pink-200">
                      <textarea
                        value={p.reportToDoctor}
                        onChange={e => handleUpdate(p.id, 'reportToDoctor', e.target.value)}
                        rows={5}
                        className="w-full p-1 border rounded-lg bg-[#fafafa]"
                        placeholder={p.prevDoctorMemoHint ? `（前回の医師指示メモ）${p.prevDoctorMemoHint}` : ''}
                      />
                    </td>
                    
                    {/* ② VS・状態報告・医師指示：入力内容から③指示内容の候補が自動で抽出されます */}
                    <td className="p-2 space-y-2 border-r-2 border-pink-200">
                      <textarea value={p.doctorMemo} onChange={e => handleDoctorMemoChange(p.id, e.target.value)} rows={4} className="w-full p-1 border rounded-lg" />
                    </td>
                    
                    {/* ③ 指示内容 ＋ ④ 日/期間（同じ行に並べることで、指示が2行になっても期間がずれない） */}
                    <td className="p-2 space-y-2 bg-[#fffbfb]">
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          value={manualOrderInput[p.id] || ''}
                          onChange={e => setManualOrderInput(prev => ({ ...prev, [p.id]: e.target.value }))}
                          onKeyDown={e => {
                            if (e.key === 'Enter') {
                              handleManualAddOrderLine(p.id, manualOrderInput[p.id] || '');
                              setManualOrderInput(prev => ({ ...prev, [p.id]: '' }));
                            }
                          }}
                          placeholder="指示を手動で追加（Enterで追加）"
                          className="flex-1 p-1.5 border border-pink-100 rounded-lg text-[11px]"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            handleManualAddOrderLine(p.id, manualOrderInput[p.id] || '');
                            setManualOrderInput(prev => ({ ...prev, [p.id]: '' }));
                          }}
                          className="no-print text-[10px] bg-pink-50 hover:bg-pink-100 text-pink-700 border border-pink-200 rounded-lg px-2 py-1.5 font-bold shrink-0"
                        >
                          ＋追加
                        </button>
                      </div>
                      
                      <div className="space-y-1 pt-1 border-t border-dashed border-pink-100">
                        {p.doctorOrder.split('\n').map((line, idx) => {
                          if (line.trim() === '') return null;
                          const status = p.orderStatus[idx] || { checked: false };
                          const createdBy = p.orderCreatedBy[idx];
                          const isEditing = editingLine?.patientId === p.id && editingLine?.lineIndex === idx;
                          const periodEntry = p.orderPeriods[idx];
                          const isEditingPeriodText = editingPeriodText?.patientId === p.id && editingPeriodText?.lineIndex === idx;
                          const alertLevel = getOrderLineAlertLevel(periodEntry, status.checked);

                          return (
                            <div
                              key={idx}
                              className={`group/row flex items-start justify-between gap-2 p-1.5 rounded-lg border transition-all select-none ${
                                status.checked
                                  ? 'bg-emerald-50 border-emerald-200 text-slate-400 font-normal line-through'
                                  : alertLevel === 'red'
                                  ? 'order-blink-red font-bold text-slate-800'
                                  : alertLevel === 'yellow'
                                  ? 'order-blink-yellow font-bold text-slate-800'
                                  : 'bg-white border-slate-200 font-bold text-slate-800'
                              }`}
                            >
                              <div className="flex items-start space-x-2 flex-1 min-w-0">
                                {/* 🔒 レ点マーク：ここをクリックした時だけチェックが切り替わる。ホバーすると実施者名がツールチップで出る */}
                                <div className="relative group/check shrink-0 mt-0.5">
                                  <button
                                    type="button"
                                    onClick={() => handleToggleOrderLine(p.id, idx)}
                                    className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] cursor-pointer transition-colors ${status.checked ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-white border-slate-300 text-transparent hover:border-emerald-400'}`}
                                  >
                                    ✓
                                  </button>
                                  {status.checked && status.Sign && (
                                    <div className="no-print absolute left-0 bottom-full mb-1 hidden group-hover/check:block bg-slate-800 text-white text-[9px] px-2 py-1 rounded whitespace-nowrap z-20 shadow-lg">
                                      👤 {status.Sign}
                                    </div>
                                  )}
                                </div>

                                {/* ✍️ 指示文言：クリックで編集モードになる（2行になってもOK） */}
                                {isEditing ? (
                                  <input
                                    autoFocus
                                    type="text"
                                    value={editingLineText}
                                    onChange={e => setEditingLineText(e.target.value)}
                                    onBlur={handleCommitEditOrderLine}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') handleCommitEditOrderLine();
                                      if (e.key === 'Escape') setEditingLine(null);
                                    }}
                                    className="flex-1 min-w-0 border border-pink-300 rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-pink-300"
                                  />
                                ) : (
                                  <span
                                    onClick={() => handleStartEditOrderLine(p.id, idx, line)}
                                    className="cursor-text break-words"
                                    title="クリックで編集"
                                  >
                                    {line}
                                  </span>
                                )}
                              </div>

                              <div className="flex items-start gap-1 shrink-0 ml-2">
                                {/* 🗓️ ④ 日/期間：指示のすぐ横に並べる（クリックで開始日・日数を編集／ダブルクリックで手動書き換え） */}
                                <div className="relative shrink-0">
                                  {isEditingPeriodText ? (
                                    <input
                                      autoFocus
                                      type="text"
                                      value={editingPeriodTextValue}
                                      onChange={e => setEditingPeriodTextValue(e.target.value)}
                                      onBlur={handleCommitEditPeriodText}
                                      onKeyDown={e => {
                                        if (e.key === 'Enter') handleCommitEditPeriodText();
                                        if (e.key === 'Escape') setEditingPeriodText(null);
                                      }}
                                      placeholder="例：8/24～30"
                                      className="w-24 text-[9px] font-mono px-1.5 py-1 rounded-lg border border-pink-300 bg-white focus:outline-none focus:ring-2 focus:ring-pink-300 no-line-through"
                                    />
                                  ) : (
                                    <button
                                      type="button"
                                      disabled={status.checked}
                                      onClick={(e) => { e.stopPropagation(); if (status.checked) return; handleOpenPeriodEditor(p.id, idx, periodEntry?.startDate || '', periodEntry?.durationDays); }}
                                      onDoubleClick={(e) => { e.stopPropagation(); if (status.checked) return; handleStartEditPeriodText(p.id, idx, formatOrderPeriod(periodEntry)); }}
                                      title={status.checked ? '🔒 実施済みのため期間は変更できません' : (isPeriodStartBeforeVisitDate(periodEntry, nextVisitDate) ? '⚠️ 開始日が診療日より前です。クリックしてご確認ください' : 'クリック：開始日・日数を選択／ダブルクリック：手動で書き換え')}
                                      className={`text-[9px] font-mono px-1.5 py-1 rounded-lg border whitespace-nowrap no-line-through ${status.checked ? 'border-slate-200 bg-slate-100 text-slate-400 cursor-not-allowed' : isPeriodStartBeforeVisitDate(periodEntry, nextVisitDate) ? 'border-rose-400 bg-rose-50 text-rose-600 font-bold' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
                                    >
                                      {status.checked ? '🔒' : isPeriodStartBeforeVisitDate(periodEntry, nextVisitDate) ? '⚠️' : '🗓️'} {formatOrderPeriod(periodEntry)}
                                    </button>
                                  )}
                                </div>

                                {/* ✏️ 記載者（編集者）：鉛筆マークにホバーすると名前がツールチップで出る */}
                                {createdBy && (
                                  <div className="relative group/edit no-print">
                                    <span className="text-[11px] cursor-default px-0.5">✏️</span>
                                    <div className="absolute right-0 bottom-full mb-1 hidden group-hover/edit:block bg-slate-800 text-white text-[9px] px-2 py-1 rounded whitespace-nowrap z-20 shadow-lg">
                                      ✏️ {createdBy}
                                    </div>
                                  </div>
                                )}
                                {/* 🗑️ マスの右欄にマウスを合わせると出てくる削除ボタン */}
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); handleDeleteOrderLine(p.id, idx); }}
                                  className="no-print opacity-0 group-hover/row:opacity-100 transition-opacity text-slate-300 hover:text-rose-500 font-bold text-sm px-1 leading-none"
                                  title="この項目を削除"
                                >
                                  ×
                                </button>
                              </div>
                            </div>

                          );
                        })}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </div>
      )}

      {/* 画面[3]: 観察要点 */}
      {currentView === 'summary' && (
        <div className={`print-container max-w-5xl mx-auto px-4 py-6 space-y-4 ${hideMainViewForPrint ? 'no-print' : ''}`}>
          <div className="bg-white p-4 rounded-2xl border shadow-md">
            <div className="flex justify-between items-start">
              <h1 className="text-base font-bold text-purple-900">📋 観察要点</h1>
              <div className="flex items-center gap-2">
                <button onClick={handleSaveAllPrn} className={`no-print text-white px-4 py-1.5 rounded-xl font-bold text-xs ${hasPrnChanges ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-slate-300'}`} title="頓用薬パネルを開いている全員分をまとめて保存します（管理者パスワードは1回だけ）">💾 保存</button>
                <button onClick={() => window.print()} className="no-print bg-purple-100 text-purple-800 px-4 py-1.5 rounded-xl font-bold text-xs border border-purple-300">🖨️</button>
                <button onClick={handleUndoLastPatientsChange} className="no-print bg-purple-100 text-purple-800 px-4 py-1.5 rounded-xl font-bold text-xs border border-purple-300" title="直前の編集を1件取り消します">↩️ 元に戻す</button>
              </div>
            </div>
          </div>
          <div className="text-right text-xs font-bold text-purple-700 whitespace-nowrap">{todayLabel}</div>

          {/* 患者一覧：エクセルのように連結された表形式（角は四角、患者ごとに区切り線） */}
          <div className="bg-white border border-slate-200 shadow-md divide-y divide-slate-300">
            {patients.map(p => (
              <div key={p.id} className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* 左：氏名＋頓用薬（クリックで開閉。選択中があれば赤字、なければ青字） */}
                <div className="space-y-2">
                  <div className={`font-bold text-base ${getNameColorClass(p.gender)}`}>{p.room} {p.name}</div>
                  <div>
                    <button
                      type="button"
                      onClick={() => togglePrnOpen(p.id)}
                      className={`flex items-center gap-1 text-xs font-bold ${hasAnyPrnSelectedNow(p) ? 'text-rose-600' : 'text-sky-600'}`}
                    >
                      <span>{hasAnyPrnSelectedNow(p) && '💊 '}頓用薬</span>
                      {hasAnyPrnSelectedNow(p) && <span className="text-[9px] bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded-full">選択あり</span>}
                      <span className={`text-[10px] transition-transform ${openPrnPatientIds[p.id] ? 'rotate-180' : ''}`}>▼</span>
                    </button>

                    {openPrnPatientIds[p.id] && (
                      <div className="mt-1.5 border rounded-xl p-2 bg-[#fffbfe] space-y-2">
                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={() => handleResetAllPrn(p.id)}
                            className="no-print text-[10px] text-slate-400 hover:text-rose-600 flex items-center gap-0.5"
                            title="選択中の頓用薬（定型項目・手動記載）をすべて消去します"
                          >
                            ↺ 初期状態に戻す
                          </button>
                        </div>
                        {/* 🖤 すでに選択した項目～Drコール注意書きまでを、太めの黒枠でひとまとまりに囲む */}
                        <div className="border-2 border-black p-1.5 space-y-2">
                        {/* ✅ 選択済みのものだけを、保存した並び順（ドラッグで変更可）で表示。未選択の候補はここには出さない */}
                        {(() => {
                          const order = prnDraftOrder[p.id] || [];
                          const manualDraft = prnDraftManualEntries[p.id] || [];
                          if (order.length === 0) {
                            return <div className="text-[10px] text-slate-400 py-1">まだ何も選択されていません。下の「未選択指示」から選んでください。</div>;
                          }
                          // 🏷️ 同じグループ（タイトル）が連続している時は【タイトル】を1回だけ表示し、重複を消す
                          let prevGroup: string | null = null;
                          return (
                            <div className="border border-rose-200 divide-y divide-rose-200">
                              {order.map((itemId, idx) => {
                                const predefinedOpt = PRN_MEDICATION_OPTIONS.find(o => o.id === itemId);
                                const manualEntry = manualDraft.find(m => m.id === itemId);
                                if (!predefinedOpt && !manualEntry) return null;
                                const currentGroup = predefinedOpt ? predefinedOpt.group : (manualEntry?.group || '');
                                const showGroupHeader = currentGroup !== '' && currentGroup !== prevGroup;
                                prevGroup = currentGroup;
                                const isEditingPredefined = !!predefinedOpt && editingPrn?.patientId === p.id && editingPrn?.itemId === predefinedOpt.id;
                                const isEditingManual = !!manualEntry && editingManualPrn?.patientId === p.id && editingManualPrn?.entryId === manualEntry.id;
                                return (
                                  <React.Fragment key={itemId}>
                                    {showGroupHeader && (
                                      <div className="px-1.5 pt-1.5 pb-0.5 bg-rose-50 text-[11px] font-extrabold text-rose-700">【{currentGroup}】</div>
                                    )}
                                    <div
                                      draggable={!isEditingPredefined && !isEditingManual}
                                      onDragStart={() => handlePrnDragStart(idx)}
                                      onDragOver={handlePrnDragOver}
                                      onDrop={() => handlePrnDrop(p.id, idx)}
                                      className="flex items-start gap-2 p-1.5 bg-rose-50 text-[11px] font-bold text-slate-800 cursor-move"
                                    >
                                      <span className="no-print text-slate-300 shrink-0 mt-0.5" title="ドラッグして並べ替え">⠿</span>
                                      {predefinedOpt ? (
                                        <>
                                          {isEditingPredefined ? (
                                            <input
                                              autoFocus
                                              type="text"
                                              value={editingPrnText}
                                              onChange={e => setEditingPrnText(e.target.value)}
                                              onBlur={handleCommitEditPrn}
                                              onKeyDown={e => {
                                                if (e.key === 'Enter') handleCommitEditPrn();
                                                if (e.key === 'Escape') setEditingPrn(null);
                                              }}
                                              className="no-print flex-1 min-w-0 border border-rose-300 rounded px-1.5 py-0.5 text-[11px] font-bold bg-white focus:outline-none focus:ring-2 focus:ring-rose-300"
                                            />
                                          ) : (
                                            <span
                                              className="flex-1 cursor-text"
                                              title="クリックで書き直せます"
                                              onClick={() => handleStartEditPrn(p.id, predefinedOpt.id, getPrnMedicationText(p, predefinedOpt))}
                                            >
                                              {getPrnMedicationText(p, predefinedOpt)}
                                            </span>
                                          )}
                                          <button
                                            type="button"
                                            onClick={() => {
                                              if (window.confirm('この項目を選択解除します。よろしいですか？')) handleToggleDraftPrn(p.id, predefinedOpt.id);
                                            }}
                                            className="no-print text-slate-300 hover:text-rose-500 font-bold text-sm leading-none"
                                            title="この項目を選択解除"
                                          >
                                            ×
                                          </button>
                                        </>
                                      ) : manualEntry && (
                                        <>
                                          {isEditingManual ? (
                                            <input
                                              autoFocus
                                              type="text"
                                              value={editingManualPrnText}
                                              onChange={e => setEditingManualPrnText(e.target.value)}
                                              onBlur={handleCommitEditManualPrn}
                                              onKeyDown={e => {
                                                if (e.key === 'Enter') handleCommitEditManualPrn();
                                                if (e.key === 'Escape') setEditingManualPrn(null);
                                              }}
                                              className="no-print flex-1 min-w-0 border border-rose-300 rounded px-1.5 py-0.5 text-[11px] font-bold bg-white focus:outline-none focus:ring-2 focus:ring-rose-300"
                                            />
                                          ) : (
                                            <span
                                              className="flex-1 cursor-text"
                                              title="クリックで書き直せます"
                                              onClick={() => handleStartEditManualPrn(p.id, manualEntry.id, manualEntry.text)}
                                            >
                                              {manualEntry.text}
                                            </span>
                                          )}
                                          <button
                                            type="button"
                                            onClick={() => {
                                              if (window.confirm('この手動記載を削除します。よろしいですか？')) handleRemoveDraftManualPrn(p.id, manualEntry.id);
                                            }}
                                            className="no-print text-slate-300 hover:text-rose-500 font-bold text-sm leading-none"
                                          >
                                            ×
                                          </button>
                                        </>
                                      )}
                                    </div>
                                  </React.Fragment>
                                );
                              })}
                            </div>
                          );
                        })()}

                        <div className="text-[9px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
                          ⚠️ 状態に応じDrコールすること。
                        </div>
                        </div>

                        {/* 🖤 「＋追加」から下は、色やフォントはそのままに薄く表示し、黒い細枠でひとまとまりに囲む */}
                        <div className="border border-black p-1.5 space-y-2 opacity-70">
                        {/* ➕ 追加：押すと候補一覧＋手動記載欄が開く（すでに選択中のものは候補から除く） */}
                        <button
                          type="button"
                          onClick={() => togglePrnAddSection(p.id)}
                          className="no-print w-full text-[11px] font-normal text-slate-400 bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-lg py-1.5 flex items-center justify-center gap-1"
                        >
                          未選択指示 <span className={`text-[9px] transition-transform ${prnAddSectionOpenIds[p.id] ? 'rotate-180' : ''}`}>▼</span>
                        </button>

                        {prnAddSectionOpenIds[p.id] && (() => {
                          // 🙈 すでに選択中の薬（他のカテゴリで選ばれた同じ文言の薬も含む）は候補一覧から除く
                          // （例：「嘔気時」と「胃部不快・胃痛」は同じ薬を定義しているため、片方を選ぶともう片方も隠す）
                          const allSelectedIds = Object.values(prnDraftSelections[p.id] || {}).flat();
                          const selectedTexts = new Set(
                            allSelectedIds
                              .map(id => PRN_MEDICATION_OPTIONS.find(o => o.id === id)?.text)
                              .filter((text): text is string => Boolean(text))
                          );
                          // 🙈 すでに全項目が選択済みなら、これ以上選ぶものが無いので「全て選択」ボタンは不要
                          const isEverythingSelected = allSelectedIds.length >= PRN_MEDICATION_OPTIONS.length;
                          // 💊 1件でも選択済みがあれば「他のセットも全て選択」、まだ何も選んでいなければ「今ある頓用薬をすべて選択」と表示を変える
                          const isPartiallySelected = allSelectedIds.length > 0 && !isEverythingSelected;
                          return (
                          <div className="space-y-2 border-t border-dashed border-slate-200 pt-2">
                            {!isEverythingSelected && (
                              <button
                                type="button"
                                onClick={() => handleSelectAllPrn(p.id)}
                                title="クリックで一覧の頓用薬を全部選択します（まだ保存されません）"
                                className="w-full text-left flex items-center gap-2 p-1.5 border transition-all text-[11px] font-normal text-slate-400 bg-white border-slate-200 hover:bg-rose-50 outline-none focus:outline-none focus-visible:outline-none"
                              >
                                <span className="w-3.5 h-3.5 shrink-0 rounded-full border border-slate-300 flex items-center justify-center text-[9px] text-transparent">●</span>
                                {isPartiallySelected ? '他のセットも全て選択' : '今ある頓用薬をすべて選択'}
                              </button>
                            )}
                            {Array.from(new Set(PRN_MEDICATION_OPTIONS.map(opt => opt.group))).map((group) => {
                              const draftSelectedIds = prnDraftSelections[p.id]?.[group] ?? [];
                              const isMultiSelectGroup = PRN_MULTI_SELECT_GROUPS.includes(group);
                              const unselectedOpts = PRN_MEDICATION_OPTIONS.filter(opt => opt.group === group && !draftSelectedIds.includes(opt.id) && !selectedTexts.has(opt.text));
                              if (unselectedOpts.length === 0) return null;
                              return (
                                <div key={group}>
                                  <div className="text-[11px] font-normal mb-0.5 text-slate-400">
                                    ■ {group}{isMultiSelectGroup && <span className="ml-1 text-[8px] font-normal opacity-70">（複数選択できます）</span>}
                                  </div>
                                  <div className="border border-slate-200 divide-y divide-slate-200">
                                    {unselectedOpts.map(opt => {
                                      const isEditingThis = editingPrn?.patientId === p.id && editingPrn?.itemId === opt.id;
                                      return (
                                        <div
                                          key={opt.id}
                                          className="group/prn relative flex items-start gap-2 p-1.5 transition-all text-[11px] font-normal text-slate-400 bg-white"
                                        >
                                          <div className="relative shrink-0 mt-0.5">
                                            <button
                                              type="button"
                                              onClick={() => handleToggleDraftPrn(p.id, opt.id)}
                                              title={PRN_MULTI_SELECT_GROUPS.includes(group) ? 'クリックで選択できます（複数選択可・まだ保存されません）' : 'クリックで選択できます（同じグループ内では1つだけ・まだ保存されません）'}
                                              className="w-3.5 h-3.5 rounded-full border flex items-center justify-center text-[9px] cursor-pointer transition-colors bg-white border-slate-300 text-transparent hover:border-rose-400"
                                            >
                                              ●
                                            </button>
                                          </div>

                                          {/* ✍️ 文言：ダブルクリックで編集モードになる（患者ごとに上書き可能）。カーソルを合わせると更新者・更新日が浮かぶ */}
                                          {isEditingThis ? (
                                            <input
                                              autoFocus
                                              type="text"
                                              value={editingPrnText}
                                              onChange={e => setEditingPrnText(e.target.value)}
                                              onBlur={handleCommitEditPrn}
                                              onKeyDown={e => {
                                                if (e.key === 'Enter') handleCommitEditPrn();
                                                if (e.key === 'Escape') setEditingPrn(null);
                                              }}
                                              className="flex-1 min-w-0 border border-rose-300 rounded px-1.5 py-0.5 text-[11px] bg-white focus:outline-none focus:ring-2 focus:ring-rose-300"
                                            />
                                          ) : (
                                            <span className="relative group/prntext inline-block">
                                              <span
                                                onDoubleClick={() => handleStartEditPrn(p.id, opt.id, getPrnMedicationText(p, opt))}
                                                className="cursor-text"
                                                title="ダブルクリックで編集"
                                              >
                                                {getPrnMedicationText(p, opt)}
                                              </span>
                                              {p.prnMedicationTextMeta[opt.id] && (
                                                <span className="no-print absolute left-0 bottom-full mb-1 hidden group-hover/prntext:block bg-slate-800 text-white text-[9px] px-2 py-1 rounded whitespace-nowrap z-30 shadow-lg">
                                                  👤 {p.prnMedicationTextMeta[opt.id].editedBy}　📅 {p.prnMedicationTextMeta[opt.id].editedAt}
                                                </span>
                                              )}
                                            </span>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })}

                            {/* ✍️ 手動記載欄：新しいカテゴリ名（例：発熱時）と内容を自由に書いて追加できる。
                                選択済み一覧の【タイトル】＋内容の2段表記と同じ見た目になるようにしている */}
                            <div className="border border-rose-200">
                              <div className="flex items-center px-1.5 pt-1.5 pb-0.5 bg-rose-50">
                                <span className="text-[11px] font-extrabold text-rose-700">【</span>
                                <input
                                  type="text"
                                  value={manualPrnGroupInput[p.id] || ''}
                                  onChange={e => setManualPrnGroupInput(prev => ({ ...prev, [p.id]: e.target.value }))}
                                  placeholder="カテゴリ名"
                                  style={{ width: `${Math.max((manualPrnGroupInput[p.id] || '').length || 4, 2) * 1.05}em` }}
                                  className="p-0 border-0 text-[11px] font-extrabold text-rose-700 bg-transparent outline-none placeholder:text-rose-300 placeholder:font-normal"
                                />
                                <span className="text-[11px] font-extrabold text-rose-700">】</span>
                              </div>
                              <div className="flex items-center gap-1 p-1.5 bg-rose-50">
                                <input
                                  type="text"
                                  value={manualPrnInput[p.id] || ''}
                                  onChange={e => setManualPrnInput(prev => ({ ...prev, [p.id]: e.target.value }))}
                                  onKeyDown={e => { if (e.key === 'Enter') handleAddDraftManualPrn(p.id); }}
                                  placeholder="例：ロキソニン１T"
                                  className="flex-1 min-w-0 p-1.5 border border-rose-200 bg-white text-[11px] font-bold text-slate-800"
                                />
                                <button
                                  type="button"
                                  onClick={() => handleAddDraftManualPrn(p.id)}
                                  className="no-print text-[10px] bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200 rounded-lg px-2 py-1.5 font-bold shrink-0"
                                >
                                  ＋追加
                                </button>
                              </div>
                            </div>
                          </div>
                          );
                        })()}

                        <button
                          type="button"
                          onClick={() => handleSavePrnSelections(p.id)}
                          className="no-print w-full bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white font-bold py-2 rounded-xl shadow-sm transition-all text-xs"
                        >
                          💾 保存
                        </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* 右：観察要点（②③の記載内容から自動で候補が挙がるチェックリスト） */}
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold text-purple-800">👁️ 観察要点</span>
                    <button
                      type="button"
                      onClick={() => handleResetObservations(p.id)}
                      className="no-print text-[9px] text-slate-400 hover:text-purple-600 flex items-center gap-0.5"
                      title="消してしまった項目を、初期状態（VS・状態報告・医師指示／指示内容から自動抽出される内容）に戻します"
                    >
                      ↺ 初期状態に戻す
                    </button>
                  </div>
                  <div className="mt-1 space-y-1">
                    {p.observationList.trim() !== '' && (
                      <div className="border border-slate-200 divide-y divide-slate-200">
                        {p.observationList.split('\n').map((item, idx) => {
                          if (item.trim() === '') return null;
                          const status = p.observationStatus[idx] || { checked: false };
                          const isEditingThis = editingObservationLine?.patientId === p.id && editingObservationLine?.lineIndex === idx;
                          return (
                            <div
                              key={idx}
                              className={`group/row flex items-center justify-between p-1.5 transition-all select-none ${status.checked ? 'bg-purple-50 text-slate-400 font-normal line-through' : 'bg-white font-bold text-slate-800'}`}
                            >
                              <div
                                className={`flex-1 min-w-0 flex items-center space-x-2 py-1 ${isEditingThis ? '' : 'cursor-text'}`}
                                onClick={() => !isEditingThis && handleStartEditObservationLine(p.id, idx, item)}
                              >
                                {isEditingThis ? (
                                  <input
                                    autoFocus
                                    type="text"
                                    value={editingObservationText}
                                    onChange={e => setEditingObservationText(e.target.value)}
                                    onClick={e => e.stopPropagation()}
                                    onBlur={handleCommitEditObservationLine}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') handleCommitEditObservationLine();
                                      if (e.key === 'Escape') setEditingObservationLine(null);
                                    }}
                                    className="no-print flex-1 min-w-0 border border-purple-300 rounded px-1.5 py-0.5 text-[11px] font-bold bg-white focus:outline-none focus:ring-2 focus:ring-purple-300"
                                  />
                                ) : (
                                  <span title="クリックで書き直せます">{item}</span>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); handleDeleteObservationLine(p.id, idx); }}
                                className="no-print opacity-0 group-hover/row:opacity-100 transition-opacity text-slate-300 hover:text-rose-500 font-bold text-sm px-1 leading-none"
                                title="この項目を削除"
                              >
                                ×
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* ➕ 手動で観察項目を追加する行：一番下に配置 */}
                    <div className="no-print flex items-center gap-1">
                      <input
                        type="text"
                        value={manualObservationInput[p.id] || ''}
                        onChange={e => setManualObservationInput(prev => ({ ...prev, [p.id]: e.target.value }))}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            handleManualAddObservationLine(p.id, manualObservationInput[p.id] || '');
                            setManualObservationInput(prev => ({ ...prev, [p.id]: '' }));
                          }
                        }}
                        className="flex-1 p-1.5 border border-purple-100 rounded-lg text-[11px]"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          handleManualAddObservationLine(p.id, manualObservationInput[p.id] || '');
                          setManualObservationInput(prev => ({ ...prev, [p.id]: '' }));
                        }}
                        className="no-print text-[10px] bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 rounded-lg px-2 py-1.5 font-bold shrink-0"
                      >
                        ＋追加
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 画面[5]: 物品管理 */}
      {currentView === 'supply' && (() => {
        // 📦 部屋図・業務連絡などからこの画面へ来た直後は、常にこの選択画面から始める。
        //    過去の作成内容・クリニック名・一覧は一切出さず、「作成する」か「履歴をみる」だけを選ばせる
        if (supplyEntryChoice === null) {
          return (
            <div className="max-w-sm mx-auto px-4 py-24 text-center space-y-4">
              <div className="text-lg font-bold text-slate-700">📦 物品管理</div>
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => {
                    // 📦 「作成する」を選んだ瞬間、必ず空欄の下書きから始める（保存済みの氏名・物品は
                    //    表示しない。実データ自体には触れないため、履歴からは引き続き参照できる）
                    setSupplyDraft({ patientSupplies: {}, commonSupplies: [], startedBlank: true });
                    setSupplyEntryChoice('create');
                  }}
                  className="w-full bg-amber-600 hover:bg-amber-700 text-white font-bold px-4 py-3 rounded-xl shadow-md"
                >
                  作成する
                </button>
                <button
                  type="button"
                  onClick={() => setSupplyEntryChoice('history')}
                  className="w-full bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-bold px-4 py-3 rounded-xl"
                >
                  履歴をみる
                </button>
              </div>
            </div>
          );
        }
        // 📜 「履歴をみる」を選んだ時は、定期履歴▼・臨時履歴▼のドロップダウンだけを表示する。
        //    どちらかの記録を選ぶと、通常の作成画面（supplyEntryChoice==='create'）へ切り替わる
        if (supplyEntryChoice === 'history') {
          return (
            <div className="max-w-sm mx-auto px-4 py-16 space-y-4">
              <button
                type="button"
                onClick={() => setSupplyEntryChoice(null)}
                className="text-xs font-bold text-slate-500 hover:text-slate-700"
              >
                ← 戻る
              </button>
              <div className="flex items-center gap-2 flex-wrap justify-center">
                <div className="relative group inline-block text-xs">
                  <button
                    type="button"
                    data-history-toggle
                    onClick={() => setOpenHistoryMenu(prev => prev === 'supply-monthly-history' ? null : 'supply-monthly-history')}
                    className="font-bold px-2 py-1 rounded-lg border inline-flex items-center gap-1 bg-white hover:bg-slate-50 text-slate-500 border-slate-200"
                  >
                    定期履歴 <span className="text-[9px]">▼</span>
                  </button>
                  <div data-history-menu className={`${openHistoryMenu === 'supply-monthly-history' ? 'block' : 'hidden group-hover:block'} absolute left-0 top-full z-30 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[8rem]`}>
                    {Object.keys(supplyMonthlyArchive).length === 0 && (
                      <div className="px-3 py-2 text-slate-400 font-bold whitespace-nowrap">記録はまだありません</div>
                    )}
                    {Object.keys(supplyMonthlyArchive).sort().map(m => {
                      const [y, mo] = m.split('-');
                      return (
                        <div key={m} className="flex items-center hover:bg-slate-50">
                          <button
                            type="button"
                            onClick={() => handleContinueEditingMonthlyArchive(m)}
                            className="flex-1 min-w-0 text-left px-3 py-1.5 text-black font-bold whitespace-nowrap"
                          >
                            {y}年{Number(mo)}月{supplyMonthlyArchive[m].savedAt ? ` ${supplyMonthlyArchive[m].savedAt}` : ''}
                            {supplyMonthlyArchive[m].updatedAt && (
                              <span className="text-rose-600"> （更新：{supplyMonthlyArchive[m].updatedAt}）</span>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (window.confirm(`${y}年${Number(mo)}月の履歴を削除します。よろしいですか？`)) {
                                const deletedEntry = supplyMonthlyArchive[m];
                                setSupplyMonthlyArchive(prev => {
                                  const next = { ...prev };
                                  delete next[m];
                                  return next;
                                });
                                if (continuingSupplyMonthlyArchiveMonth === m || displayedSupplyMonthlyArchiveMonth === m) {
                                  const deletedIds = new Set<string>();
                                  deletedEntry?.commonSupplies.forEach(s => deletedIds.add(s.id));
                                  deletedEntry?.patients.forEach(p => p.supplies.forEach(s => deletedIds.add(s.id)));
                                  setCommonSupplies(prev => prev.filter(s => !deletedIds.has(s.id)));
                                  setPatients(prev => prev.map(p => {
                                    if (!p.supplies.some(s => deletedIds.has(s.id))) return p;
                                    return touchLastEdited({ ...p, supplies: p.supplies.filter(s => !deletedIds.has(s.id)) });
                                  }));
                                  setContinuingSupplyMonthlyArchiveMonth(null);
                                  setDisplayedSupplyMonthlyArchiveMonth(null);
                                  setSupplyDraft(null);
                                  setIsSupplyNewCreationOpen(false);
                                  setBillingMonth(getTodayISO().slice(0, 7));
                                }
                              }
                            }}
                            className="shrink-0 text-slate-300 hover:text-rose-500 font-bold text-sm leading-none px-2"
                            title="この履歴を削除"
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="relative group inline-block text-xs">
                  <button
                    type="button"
                    data-history-toggle
                    onClick={() => setOpenHistoryMenu(prev => prev === 'supply-temporary-history' ? null : 'supply-temporary-history')}
                    className="font-bold px-2 py-1 rounded-lg border inline-flex items-center gap-1 bg-white hover:bg-slate-50 text-rose-600 border-rose-200"
                  >
                    臨時履歴 <span className="text-[9px]">▼</span>
                  </button>
                  <div data-history-menu className={`${openHistoryMenu === 'supply-temporary-history' ? 'block' : 'hidden group-hover:block'} absolute left-0 top-full z-30 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[8rem]`}>
                    {Object.keys(supplyTemporaryArchive).length === 0 && (
                      <div className="px-3 py-2 text-slate-400 font-bold whitespace-nowrap">記録はまだありません</div>
                    )}
                    {Object.keys(supplyTemporaryArchive).sort().map(d => (
                      <div key={d} className="flex items-center hover:bg-slate-50">
                        <button
                          type="button"
                          onClick={() => handleContinueEditingTemporaryArchive(d)}
                          className="flex-1 min-w-0 text-left px-3 py-1.5 text-black font-bold whitespace-nowrap"
                        >
                          {formatISOToJapaneseDate(d.slice(0, 10))}{supplyTemporaryArchive[d].savedAt ? ` ${supplyTemporaryArchive[d].savedAt}` : ''}
                          {supplyTemporaryArchive[d].updatedAt && (
                            <span className="text-rose-600"> （更新：{supplyTemporaryArchive[d].updatedAt}）</span>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`${formatISOToJapaneseDate(d.slice(0, 10))}${supplyTemporaryArchive[d].savedAt ? ` ${supplyTemporaryArchive[d].savedAt}` : ''}の履歴を削除します。よろしいですか？`)) {
                              const deletedEntry = supplyTemporaryArchive[d];
                              setSupplyTemporaryArchive(prev => {
                                const next = { ...prev };
                                delete next[d];
                                return next;
                              });
                              if (continuingSupplyTemporaryArchiveKey === d || displayedSupplyTemporaryArchiveKey === d) {
                                const deletedIds = new Set<string>();
                                deletedEntry?.commonSupplies.forEach(s => deletedIds.add(s.id));
                                deletedEntry?.patients.forEach(p => p.supplies.forEach(s => deletedIds.add(s.id)));
                                setCommonSupplies(prev => prev.filter(s => !deletedIds.has(s.id)));
                                setPatients(prev => prev.map(p => {
                                  if (!p.supplies.some(s => deletedIds.has(s.id))) return p;
                                  return touchLastEdited({ ...p, supplies: p.supplies.filter(s => !deletedIds.has(s.id)) });
                                }));
                                setContinuingSupplyTemporaryArchiveKey(null);
                                setDisplayedSupplyTemporaryArchiveKey(null);
                                setSupplyDraft(null);
                                setIsSupplyNewCreationOpen(false);
                              }
                            }
                          }}
                          className="shrink-0 text-slate-300 hover:text-rose-500 font-bold text-sm leading-none px-2"
                          title="この履歴を削除"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        }
        // 📦 物品管理は「保存」ボタンを押すまで確定しない下書き方式のため、下書き（supplyDraft）から表示する。
        //    画面を開いた直後、下書きがまだ用意できていない一瞬だけは何も表示しない（すぐ用意され再描画される）
        if (!supplyDraft) return null;
        // 💾 下書き（supplyDraft）が、保存済みの実データ（patients・commonSupplies）からまだ何も変わっていないか。
        //    修正せず開いただけならtrue（保存ボタンをグレーにする）、何か変更があればfalse（緑にする）。
        // 📜 定期履歴・臨時履歴から「追加修正」で過去の記録を開いている間は、実データとの参照比較が
        //    偶然一致してしまう場合があるため（＝編集前と同じ内容の記録を開いた時など）、常に保存できる
        // ようにする（この状態自体が「履歴を上書き保存するために開いている」ことを意味するため）
        const hasNoSupplyDraftChanges = !continuingSupplyMonthlyArchiveMonth && !continuingSupplyTemporaryArchiveKey
          && (supplyDraft.startedBlank
            ? supplyDraft.commonSupplies.length === 0 && Object.keys(supplyDraft.patientSupplies).length === 0
            : supplyDraft.commonSupplies === commonSupplies
              && patients.every(p => {
                const next = supplyDraft.patientSupplies[p.id];
                return !next || next === p.supplies;
              }));
        // 📦 物品管理には、物品名が1件でも入力されている人だけを表示する（物品名が空の項目しか無い人は表示しない）
        const hasNamedSupply = (list: SupplyItem[]) => list.some(s => s.name.trim() !== '');
        const draftPatientsView = patients.map(p => ({
          ...p,
          supplies: supplyDraft.patientSupplies[p.id] ?? (supplyDraft.startedBlank ? [] : p.supplies),
        }));
        const shownPatients = draftPatientsView.filter(p => hasNamedSupply(p.supplies));
        const addablePatients = draftPatientsView.filter(p => !hasNamedSupply(p.supplies));
        // 📦 共通物品も、物品名が1件でも入力されて初めて一覧に表示する（入居者と同じルール）
        const hasNamedCommonSupply = hasNamedSupply(supplyDraft.commonSupplies);
        // 📊 TOTAL：氏名・共通物品を問わず、物品名が同じものを定数（allocated）で合計する。
        //    同じ物品名でも「定数」と「臨時」は別々に集計する
        const allSupplyItemsForTotal: SupplyItem[] = [...draftPatientsView.flatMap(p => p.supplies), ...supplyDraft.commonSupplies];
        const buildSupplyTotals = (kind: '定数' | '臨時'): { name: string; unit: '個' | '箱'; total: number }[] => {
          // 📦 同じ物品名でも「個」「箱」で単位が違う場合があるため、名前＋単位で分けて集計する
          const totals = new Map<string, { name: string; unit: '個' | '箱'; total: number }>();
          allSupplyItemsForTotal.forEach(s => {
            const trimmedName = s.name.trim();
            if (!trimmedName || (s.kind || '定数') !== kind) return;
            const unit = s.unit || '個';
            const key = `${trimmedName}__${unit}`;
            const existing = totals.get(key);
            if (existing) existing.total += s.allocated;
            else totals.set(key, { name: trimmedName, unit, total: s.allocated });
          });
          return sortJaAsc(Array.from(totals.values()), t => t.name);
        };
        const fixedSupplyTotals = buildSupplyTotals('定数');
        const temporarySupplyTotals = buildSupplyTotals('臨時');
        return (
        <div className={`max-w-5xl mx-auto px-4 py-6 space-y-4 ${hideMainViewForPrint ? 'no-print' : ''}`}>
          <div className="relative bg-white rounded-2xl border p-4 shadow-md bg-gradient-to-r from-amber-50 to-white">
            {/* 💾 物品管理の保存：定期作成・臨時作成を開いていなくても、定数・在庫・使用予定日などの
                その場での修正はすべてここから保存する。どの画面でも常に右上・同じ場所に固定し、
                修正が無ければグレー、何か変更があれば緑にして一目でわかるようにする */}
            <button
              type="button"
              onClick={handleSaveSupplyDraft}
              disabled={hasNoSupplyDraftChanges}
              title="定数・在庫・メモ・使用予定日などの変更を保存します（押すまでは確定しません）"
              className={`no-print absolute top-3 right-3 z-10 px-3 py-1.5 rounded-xl font-bold text-xs whitespace-nowrap shadow-sm text-white ${hasNoSupplyDraftChanges ? 'bg-slate-300 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-700'}`}
            >
              💾 保存
            </button>
            <div className="flex items-center gap-3 flex-wrap pr-24">
              <div className="relative no-print flex-1 min-w-[12rem] max-w-md">
                <input
                  type="text"
                  value={clinicName}
                  onChange={e => setClinicName(e.target.value)}
                  onFocus={() => setIsClinicHistoryOpen(true)}
                  onBlur={() => { handleClinicNameBlur(); setIsClinicHistoryOpen(false); }}
                  placeholder="クリニック名を入力（クリックすると入力履歴から選択できます）"
                  title="クリックすると、これまでに入力したクリニック名の履歴から選べます"
                  className="text-base font-bold text-amber-900 bg-transparent border-b-2 border-amber-200 focus:border-amber-500 outline-none w-full placeholder:text-amber-300 placeholder:font-normal"
                />
                {isClinicHistoryOpen && clinicNameHistory.length > 0 && (
                  <div className="absolute z-20 mt-1 bg-white border border-amber-200 rounded-xl shadow-lg w-full max-h-48 overflow-y-auto">
                    {sortByGuessedReading(clinicNameHistory, n => n).map(name => (
                      <div key={name} className="flex items-center hover:bg-amber-50">
                        <button
                          type="button"
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => { setClinicName(name); setIsClinicHistoryOpen(false); }}
                          className="flex-1 min-w-0 text-left px-3 py-1.5 text-sm font-normal text-slate-700"
                        >
                          {name}
                        </button>
                        <button
                          type="button"
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => {
                            if (window.confirm('この履歴を削除します。よろしいですか？')) handleDeleteClinicNameHistory(name);
                          }}
                          className="shrink-0 text-slate-300 hover:text-rose-500 font-bold text-sm leading-none px-2"
                          title="この履歴を削除"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <select
                value={clinicHonorific}
                onChange={e => handleClinicHonorificChange(e.target.value as '御中' | '様' | '先生')}
                title="クリニック名の右に付ける敬称を選べます"
                className="no-print text-sm font-bold text-amber-900 bg-transparent border-b-2 border-amber-200 focus:border-amber-500 outline-none shrink-0"
              >
                <option value="御中">御中</option>
                <option value="様">様</option>
                <option value="先生">先生</option>
              </select>
              <div className="no-print ml-auto flex items-start gap-3 flex-wrap justify-end">
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => openSupplyNewCreation('定数')}
                  title="押すと、月を進める操作と氏名・物品の選択エリアが表示されます"
                  className="w-28 text-xs font-bold rounded-xl px-2 py-1.5 border bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
                >
                  定期作成
                </button>
                <button
                  type="button"
                  onClick={() => openSupplyNewCreation('臨時')}
                  title="押すと、臨時の物品として氏名・物品の選択エリアが表示されます"
                  className={`w-28 text-xs font-bold rounded-xl px-2 py-1.5 border ${isSupplyNewCreationOpen && supplyNewCreationKind === '臨時' ? 'bg-rose-600 border-rose-600 text-white' : 'bg-white border-rose-200 text-rose-600 hover:bg-slate-50'}`}
                >
                  臨時作成
                </button>
              </div>
              <div className="flex flex-col gap-1">
                <button onClick={() => handlePrintSupplySheet(false)} title="在庫の列も含めて印刷します" className="w-28 bg-amber-600 text-white px-2 py-1.5 rounded-xl font-bold text-xs whitespace-nowrap">🖨️ 在庫を含む</button>
                <button onClick={() => handlePrintSupplySheet(true)} title="在庫の列を除いて印刷します" className="w-28 bg-white text-amber-700 border border-amber-300 px-2 py-1.5 rounded-xl font-bold text-xs whitespace-nowrap">🖨️ 在庫を除く</button>
              </div>
              </div>
            </div>
            <h1 className="print-only text-base font-bold text-amber-900">{clinicName ? `${clinicName} ${clinicHonorific}` : '医療物品・バルン交換管理'}</h1>
          </div>
          <div className="text-right text-xs font-bold text-amber-700 whitespace-nowrap">{formatISOToJapaneseDate(supplyPrintDate)}</div>
          <div className="no-print flex items-center gap-2">
            {/* 📦 定期履歴：定期作成で保存するたびに、月をキーとして記録される（月に1回だけ・修正すると上書き） */}
            <div className="relative group inline-block text-xs">
              <button
                type="button"
                data-history-toggle
                onClick={() => setOpenHistoryMenu(prev => prev === 'supply-monthly' ? null : 'supply-monthly')}
                className="font-bold px-2 py-1 rounded-lg border inline-flex items-center gap-1 bg-white hover:bg-slate-50 text-slate-500 border-slate-200"
              >
                定期履歴 <span className="text-[9px]">▼</span>
              </button>
              <div data-history-menu className={`${openHistoryMenu === 'supply-monthly' ? 'block' : 'hidden group-hover:block'} absolute left-0 top-full z-30 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[8rem]`}>
                {Object.keys(supplyMonthlyArchive).length === 0 && (
                  <div className="px-3 py-2 text-slate-400 font-bold whitespace-nowrap">記録はまだありません</div>
                )}
                {Object.keys(supplyMonthlyArchive).sort().map(m => {
                  const [y, mo] = m.split('-');
                  return (
                    <div key={m} className="flex items-center hover:bg-slate-50">
                      <button
                        type="button"
                        onClick={() => { handleContinueEditingMonthlyArchive(m); setOpenHistoryMenu(null); }}
                        className="flex-1 min-w-0 text-left px-3 py-1.5 text-black font-bold whitespace-nowrap"
                      >
                        {y}年{Number(mo)}月{supplyMonthlyArchive[m].savedAt ? ` ${supplyMonthlyArchive[m].savedAt}` : ''}
                        {supplyMonthlyArchive[m].updatedAt && (
                          <span className="text-rose-600"> （更新：{supplyMonthlyArchive[m].updatedAt}）</span>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`${y}年${Number(mo)}月の履歴を削除します。よろしいですか？`)) {
                            const deletedEntry = supplyMonthlyArchive[m];
                            setSupplyMonthlyArchive(prev => {
                              const next = { ...prev };
                              delete next[m];
                              return next;
                            });
                            // 📜 削除した記録が、今まさに画面（＝実データ）に表示されている内容と同じ場合は
                            //    （追加修正中だった場合はもちろん、新規作成・修正してそのまま保存した直後の
                            //    場合も含む）、臨時履歴と同様にその記録に含まれていた物品を実データからも
                            //    取り除き、画面から消す
                            if (continuingSupplyMonthlyArchiveMonth === m || displayedSupplyMonthlyArchiveMonth === m) {
                              const deletedIds = new Set<string>();
                              deletedEntry?.commonSupplies.forEach(s => deletedIds.add(s.id));
                              deletedEntry?.patients.forEach(p => p.supplies.forEach(s => deletedIds.add(s.id)));
                              setCommonSupplies(prev => prev.filter(s => !deletedIds.has(s.id)));
                              setPatients(prev => prev.map(p => {
                                if (!p.supplies.some(s => deletedIds.has(s.id))) return p;
                                return touchLastEdited({ ...p, supplies: p.supplies.filter(s => !deletedIds.has(s.id)) });
                              }));
                              setContinuingSupplyMonthlyArchiveMonth(null);
                              setDisplayedSupplyMonthlyArchiveMonth(null);
                              setSupplyDraft(null);
                              setIsSupplyNewCreationOpen(false);
                              setBillingMonth(getTodayISO().slice(0, 7));
                            }
                          }
                        }}
                        className="shrink-0 text-slate-300 hover:text-rose-500 font-bold text-sm leading-none px-2"
                        title="この履歴を削除"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* 📦 臨時履歴：臨時作成で保存するたびに、実際に保存した日をキーとして記録される（ひと月に何回でも残る） */}
            <div className="relative group inline-block text-xs">
              <button
                type="button"
                data-history-toggle
                onClick={() => setOpenHistoryMenu(prev => prev === 'supply-temporary' ? null : 'supply-temporary')}
                className="font-bold px-2 py-1 rounded-lg border inline-flex items-center gap-1 bg-white hover:bg-slate-50 text-rose-600 border-rose-200"
              >
                臨時履歴 <span className="text-[9px]">▼</span>
              </button>
              <div data-history-menu className={`${openHistoryMenu === 'supply-temporary' ? 'block' : 'hidden group-hover:block'} absolute left-0 top-full z-30 bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[8rem]`}>
                {Object.keys(supplyTemporaryArchive).length === 0 && (
                  <div className="px-3 py-2 text-slate-400 font-bold whitespace-nowrap">記録はまだありません</div>
                )}
                {Object.keys(supplyTemporaryArchive).sort().map(d => (
                  <div key={d} className="flex items-center hover:bg-slate-50">
                    <button
                      type="button"
                      onClick={() => { handleContinueEditingTemporaryArchive(d); setOpenHistoryMenu(null); }}
                      className="flex-1 min-w-0 text-left px-3 py-1.5 text-black font-bold whitespace-nowrap"
                    >
                      {formatISOToJapaneseDate(d.slice(0, 10))}{supplyTemporaryArchive[d].savedAt ? ` ${supplyTemporaryArchive[d].savedAt}` : ''}
                      {supplyTemporaryArchive[d].updatedAt && (
                        <span className="text-rose-600"> （更新：{supplyTemporaryArchive[d].updatedAt}）</span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`${formatISOToJapaneseDate(d.slice(0, 10))}${supplyTemporaryArchive[d].savedAt ? ` ${supplyTemporaryArchive[d].savedAt}` : ''}の履歴を削除します。よろしいですか？`)) {
                          const deletedEntry = supplyTemporaryArchive[d];
                          setSupplyTemporaryArchive(prev => {
                            const next = { ...prev };
                            delete next[d];
                            return next;
                          });
                          // 📜 削除した記録が、今まさに画面（＝実データ）に表示されている内容と同じ場合は
                          //    （追加修正中だった場合はもちろん、新規作成してそのまま保存した直後の場合も含む）、
                          //    その記録に含まれていた物品を実データからも取り除き、画面から消す
                          if (continuingSupplyTemporaryArchiveKey === d || displayedSupplyTemporaryArchiveKey === d) {
                            const deletedIds = new Set<string>();
                            deletedEntry?.commonSupplies.forEach(s => deletedIds.add(s.id));
                            deletedEntry?.patients.forEach(p => p.supplies.forEach(s => deletedIds.add(s.id)));
                            setCommonSupplies(prev => prev.filter(s => !deletedIds.has(s.id)));
                            setPatients(prev => prev.map(p => {
                              if (!p.supplies.some(s => deletedIds.has(s.id))) return p;
                              return touchLastEdited({ ...p, supplies: p.supplies.filter(s => !deletedIds.has(s.id)) });
                            }));
                            setContinuingSupplyTemporaryArchiveKey(null);
                            setDisplayedSupplyTemporaryArchiveKey(null);
                            setSupplyDraft(null);
                            setIsSupplyNewCreationOpen(false);
                          }
                        }
                      }}
                      className="shrink-0 text-slate-300 hover:text-rose-500 font-bold text-sm leading-none px-2"
                      title="この履歴を削除"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
            {/* 🗓️ 物品の「作成日」：クリニックへ送る文書に、いつの物品が欲しいのかを明記するために選び直せる。
                印刷時もこの日付を大きめに表記する */}
            <div className="relative">
              <button
                type="button"
                onClick={openSupplyItemCreationDateCalendar}
                className="text-sm font-bold text-amber-900 whitespace-nowrap px-2 py-1 rounded-lg border border-amber-200 bg-white hover:bg-amber-50"
              >
                🗓️ 作成日：{supplyNewCreationKind === '定数' ? formatSupplyItemCreationMonthLabel(supplyItemCreationDate) : (formatISOToJapaneseDate(supplyItemCreationDate) || '未設定')}
              </button>
              {isSupplyItemCreationDateCalendarOpen && (
                <div className="absolute left-0 top-full mt-1 z-30 bg-white border border-amber-200 rounded-xl shadow-lg p-2 w-56">
                  <div className="flex items-center justify-between mb-1.5">
                    <button type="button" onClick={() => shiftSupplyItemCreationDateCalendarMonth(-1)} className="w-7 h-7 rounded-lg border border-amber-200 bg-white hover:bg-amber-50 text-xs font-bold">◀</button>
                    <div className="text-xs font-bold text-amber-900">
                      {(() => {
                        const [y, m] = (supplyItemCreationDateCalendarViewMonth || getTodayISO().slice(0, 7)).split('-');
                        return `${y}年${Number(m)}月`;
                      })()}
                    </div>
                    <button type="button" onClick={() => shiftSupplyItemCreationDateCalendarMonth(1)} className="w-7 h-7 rounded-lg border border-amber-200 bg-white hover:bg-amber-50 text-xs font-bold">▶</button>
                  </div>
                  {supplyNewCreationKind === '定数' ? (
                    // 📦 定期作成の作成日は月だけで十分なため、日にちは選ばせず月だけを選択する
                    <button
                      type="button"
                      onClick={() => handleSelectSupplyItemCreationDate(`${supplyItemCreationDateCalendarViewMonth || getTodayISO().slice(0, 7)}-01`)}
                      className="w-full bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs rounded-lg py-1.5"
                    >
                      この月を選択
                    </button>
                  ) : (
                    <div className="grid grid-cols-7 gap-0.5 text-center">
                      {JST_WEEKDAYS.map(w => (
                        <div key={w} className="text-[9px] font-bold text-slate-400">{w}</div>
                      ))}
                      {getCalendarMonthCells(supplyItemCreationDateCalendarViewMonth || getTodayISO().slice(0, 7)).map((iso, idx) => {
                        if (!iso) return <div key={idx} />;
                        const isSelected = supplyItemCreationDate === iso;
                        const isToday = getTodayISO() === iso;
                        return (
                          <button
                            key={iso}
                            type="button"
                            onClick={() => handleSelectSupplyItemCreationDate(iso)}
                            className={`w-6 h-6 rounded text-[10px] font-bold flex items-center justify-center ${isSelected ? 'bg-amber-600 text-white' : isToday ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'hover:bg-amber-50 text-slate-700'}`}
                          >
                            {Number(iso.slice(8, 10))}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          {isSupplyNewCreationOpen && (
          <div>
            {/* 📦 定期作成／臨時作成のどちらを押して開いたか、氏名選択の上に大きく表記して一目でわかるようにする。
                「定期」「臨時」どちらの時も、印刷時にこの左上の位置にそのまま印字する */}
            <div className="mb-1 flex items-center gap-2">
              <div className={`text-lg font-bold ${supplyNewCreationKind === '臨時' ? 'text-rose-600' : 'text-black'}`}>
                {supplyNewCreationKind === '臨時'
                  ? `臨時：${formatISOToJapaneseDate(supplyItemCreationDate)}分`
                  : `定期：${formatBillingMonthLabel((supplyItemCreationDate || getTodayISO()).slice(0, 7))}`}
              </div>
            </div>
            {supplyNewCreationKind === '定数' && isSupplyFixedCreationChoiceOpen ? (
              <div className="no-print bg-white rounded-2xl border p-6 shadow-sm text-center space-y-3">
                <div className="text-sm font-bold text-slate-700">どちらで作成しますか？</div>
                <div className="flex flex-col sm:flex-row gap-2 justify-center">
                  <button
                    type="button"
                    onClick={handleStartFixedCreationCarryForward}
                    className="flex-1 sm:flex-none px-4 py-2 rounded-xl border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800 font-bold text-xs"
                  >
                    先月の定数を引き継いで作成
                  </button>
                  <button
                    type="button"
                    onClick={handleStartFixedCreationFresh}
                    className="flex-1 sm:flex-none px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs"
                  >
                    新規作成
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelFixedCreationChoice}
                    className="flex-1 sm:flex-none px-4 py-2 rounded-xl border border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-500 font-bold text-xs"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            ) : (
            <div className="no-print bg-white rounded-2xl border p-3 shadow-sm flex items-center gap-3 flex-wrap">
            <div
              onDoubleClick={() => { setSupplyNewCreationKind('定数'); setIsSupplyPatientPickerOpen(true); }}
              role="button"
              title="ダブルクリックで、物品管理に追加する入居者を部屋図から選べます"
              className="inline-flex items-center gap-1 font-bold text-sm text-amber-900 cursor-pointer select-none hover:text-amber-600"
            >
              氏名
            </div>
            <select
              value=""
              onChange={e => {
                const patientId = e.target.value;
                if (patientId) handleSelectSupplyPatient(patientId);
              }}
              title="部屋図に登録されている氏名から選んで、物品を追加できます"
              className="text-xs font-bold text-amber-900 bg-transparent border-b-2 border-amber-200 focus:border-amber-500 outline-none"
            >
              <option value="">▼ 氏名を選んで物品を追加</option>
              <option value={COMMON_SUPPLY_ID}>📦 共通物品</option>
              {/* 📦 臨時作成の時は、すでに定数の物品がある人にも臨時の物品を追加できるよう、全員を選択肢に出す。
                  定期作成の時は、これまで通りまだ何も物品名が無い人だけを選択肢に出す */}
              {sortByGuessedReading(supplyNewCreationKind === '臨時' ? draftPatientsView : addablePatients, p => p.name).map(p => (
                <option key={p.id} value={p.id}>{p.room}号室 {p.name}</option>
              ))}
            </select>
            </div>
            )}
          </div>
          )}
          <div className="bg-white border border-slate-200 shadow-md divide-y divide-slate-300">
            {shownPatients.length === 0 && !hasNamedCommonSupply && (
              <div className="p-6 text-center text-xs text-slate-400">まだ物品管理に追加された方はいません。</div>
            )}
            {/* 📦 共通物品：特定の入居者に紐づかない、施設共通の物品。一番上に表示する */}
            {hasNamedCommonSupply && (
              <div className="p-4 space-y-2">
                <div className="font-bold text-amber-700">📦 共通物品</div>
                <table className="w-full text-xs text-left">
                  <thead><tr className="bg-slate-50 border-b"><th>物品名</th><th className="text-center w-32">定数</th><th className={`text-center w-24 ${supplyPrintHideStock ? 'no-print' : ''}`}>在庫</th><th className="no-print w-6"></th></tr></thead>
                  <tbody className="divide-y">{supplyDraft.commonSupplies.map(s => (
                    <tr key={s.id} className="group/supplyrow">
                      <td>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleOpenSupplyItemEditor(COMMON_SUPPLY_ID, s.id, s.name, s.allocated, s.unit || '個', s.kind || '定数')}
                            title="クリックして物品一覧から変更（書き間違いの修正など）"
                            className="hover:underline hover:text-amber-700 text-left"
                          >
                            📦 {s.name}
                          </button>
                          <button
                            type="button"
                            onClick={() => setExpandedSupplyMemoIds(prev => {
                              const next = new Set(prev);
                              if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                              return next;
                            })}
                            title="メモ欄を開く・閉じる"
                            className="no-print shrink-0 text-amber-500 hover:text-amber-700 font-bold text-xs px-1"
                          >
                            ＋
                          </button>
                        </div>
                        {(expandedSupplyMemoIds.has(s.id) || (s.memo || '').trim() !== '') && (
                          <input
                            type="text"
                            value={s.memo || ''}
                            onChange={e => handleUpdateSupplyMemo(COMMON_SUPPLY_ID, s.id, e.target.value)}
                            placeholder="用途：必要定数変更および追加調達依頼内容"
                            className="w-full mt-1 p-1 border rounded text-[10px] text-slate-600"
                          />
                        )}
                      </td>
                      <td className="text-center relative align-top py-2">
                        <div className="flex items-center justify-center gap-1">
                          {(s.kind || '定数') === '臨時' && <span className="text-[10px] font-bold text-rose-600 print:text-sm print:px-1.5 print:py-0.5 print:border-2 print:border-rose-600 print:rounded print:bg-rose-50">臨時</span>}
                          {editingSupplyAllocatedKey === `${COMMON_SUPPLY_ID}::${s.id}` ? (
                            <input
                              type="number"
                              autoFocus
                              value={editingSupplyAllocatedValue}
                              onChange={e => setEditingSupplyAllocatedValue(e.target.value)}
                              onBlur={e => handleCommitEditSupplyAllocated(COMMON_SUPPLY_ID, s.id, s.allocated, e.currentTarget.getBoundingClientRect())}
                              onKeyDown={e => { if (e.key === 'Enter') handleCommitEditSupplyAllocated(COMMON_SUPPLY_ID, s.id, s.allocated, e.currentTarget.getBoundingClientRect()); }}
                              className="w-10 border rounded text-center p-0.5"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleStartEditSupplyAllocated(COMMON_SUPPLY_ID, s.id, s.allocated)}
                              title="クリックして定数を変更"
                              className="w-10 border rounded text-center p-0.5 bg-white hover:bg-amber-50 font-bold text-slate-700"
                            >
                              {s.allocated}
                            </button>
                          )}{s.unit || '個'}
                          <button
                            type="button"
                            onClick={() => openSupplyDateCalendar(COMMON_SUPPLY_ID, s.id)}
                            title="使用予定日を追加する（追加後、左のレ点にチェックすると在庫が1減ります）"
                            className="no-print shrink-0 text-amber-600 hover:text-amber-800"
                          >
                            🗓️
                          </button>
                        </div>
                        {s.scheduledUseDates.length > 0 && (
                          <div className="no-print flex flex-wrap justify-center gap-1 mt-1">
                            {[...s.scheduledUseDates].sort((a, b) => a.date.localeCompare(b.date)).map((entry, entryIdx) => {
                              // 🚨 定数の件数（s.allocated）を超えた分（最初に指定した日にち以外）は赤字で警告表示する
                              const isOverLimit = entryIdx >= s.allocated;
                              return (
                                <span
                                  key={entry.date}
                                  className={`inline-flex items-center text-[9px] font-bold px-1 rounded ${
                                    isOverLimit
                                      ? (entry.applied ? 'text-rose-400 line-through' : 'text-rose-600 bg-rose-50 border border-rose-300')
                                      : (entry.applied ? 'text-slate-400 line-through' : 'text-amber-700 bg-amber-50 border border-amber-200')
                                  }`}
                                >
                                  <button
                                    type="button"
                                    onClick={() => handleToggleSupplyUseDateChecked(COMMON_SUPPLY_ID, s.id, entry.date)}
                                    title="チェックすると在庫を1減らします（チェックを外すと在庫を1戻します）"
                                    className={`mr-0.5 w-3 h-3 rounded-sm border flex items-center justify-center leading-none ${
                                      isOverLimit
                                        ? (entry.applied ? 'bg-rose-600 border-rose-600 text-white' : 'bg-white border-rose-400 text-transparent')
                                        : (entry.applied ? 'bg-amber-600 border-amber-600 text-white' : 'bg-white border-amber-300 text-transparent')
                                    }`}
                                  >
                                    ✓
                                  </button>
                                  {formatDateShort(entry.date)}
                                  {!entry.applied && (
                                    <button type="button" onClick={() => handleRemoveSupplyUseDate(COMMON_SUPPLY_ID, s.id, entry.date)} className="ml-0.5 text-rose-400 hover:text-rose-600">×</button>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        )}
                        {/* 🖨️ 印刷時：定数の項目はカレンダーで選んだ日を「▢9/7」の形で表記し、定数の数と
                            カレンダーで作成した日の数が一致するか一目で確認できるようにする */}
                        {(s.kind || '定数') === '定数' && s.scheduledUseDates.length > 0 && (
                          <div className="print-only flex flex-wrap justify-center gap-1 mt-1 text-[9px] font-bold text-slate-700">
                            {[...s.scheduledUseDates].sort((a, b) => a.date.localeCompare(b.date)).map(entry => (
                              <span key={entry.date}>▢{formatDateShort(entry.date)}</span>
                            ))}
                          </div>
                        )}
                        {openSupplyDateCalendarKey === `${COMMON_SUPPLY_ID}::${s.id}` && (
                          <div className="absolute z-30 mt-1 left-1/2 -translate-x-1/2 bg-white border border-amber-200 rounded-xl shadow-lg p-2 w-56 text-left">
                            <div className="flex items-center justify-between mb-1.5">
                              <button type="button" onClick={() => shiftSupplyDateCalendarMonth(-1)} className="w-7 h-7 rounded-lg border border-amber-200 bg-white hover:bg-amber-50 text-xs font-bold">◀</button>
                              <div className="text-xs font-bold text-amber-900">
                                {(() => {
                                  const [y, m] = (supplyDateCalendarMonth || getTodayISO().slice(0, 7)).split('-');
                                  return `${y}年${Number(m)}月`;
                                })()}
                              </div>
                              <button type="button" onClick={() => shiftSupplyDateCalendarMonth(1)} className="w-7 h-7 rounded-lg border border-amber-200 bg-white hover:bg-amber-50 text-xs font-bold">▶</button>
                            </div>
                            <div className="text-[9px] text-slate-400 mb-1">複数の日にちを選んでから保存できます</div>
                            <div className="grid grid-cols-7 gap-0.5 text-center">
                              {JST_WEEKDAYS.map(w => (
                                <div key={w} className="text-[9px] font-bold text-slate-400">{w}</div>
                              ))}
                              {getCalendarMonthCells(supplyDateCalendarMonth || getTodayISO().slice(0, 7)).map((iso, idx) => {
                                if (!iso) return <div key={idx} />;
                                const isSelected = supplyDateDraftSelection.includes(iso);
                                const isToday = getTodayISO() === iso;
                                return (
                                  <button
                                    key={iso}
                                    type="button"
                                    onClick={() => toggleSupplyDateDraftSelection(iso, Math.max(0, s.allocated - s.scheduledUseDates.length))}
                                    className={`w-6 h-6 rounded text-[10px] font-bold flex items-center justify-center ${isSelected ? 'bg-amber-600 text-white' : isToday ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'hover:bg-amber-50 text-slate-700'}`}
                                  >
                                    {Number(iso.slice(8, 10))}
                                  </button>
                                );
                              })}
                            </div>
                            {/* 🗓️ 曜日＋間隔での一括選択：例「月」＋「2週間おき」→表示中の月の対象曜日を2週間おきに自動選択 */}
                            <div className="mt-1.5 pt-1.5 border-t border-slate-100">
                              <div className="grid grid-cols-7 gap-0.5">
                                {JST_WEEKDAYS.map((w, idx) => (
                                  <button
                                    key={w}
                                    type="button"
                                    onClick={() => setSupplyRecurringWeekday(idx)}
                                    className={`text-[9px] font-bold py-1 rounded ${supplyRecurringWeekday === idx ? 'bg-amber-600 text-white' : 'bg-slate-50 text-slate-600 hover:bg-amber-50'}`}
                                  >
                                    {w}
                                  </button>
                                ))}
                              </div>
                              <div className="flex gap-1 mt-1">
                                <button
                                  type="button"
                                  disabled={supplyRecurringWeekday === null}
                                  onClick={() => handleApplyRecurringSupplyDates(14, Math.max(0, s.allocated - s.scheduledUseDates.length))}
                                  className={`flex-1 text-[10px] font-bold py-1 rounded border disabled:text-slate-300 disabled:bg-slate-50 disabled:cursor-not-allowed ${supplyRecurringIntervalDays === 14 ? 'bg-amber-600 border-amber-600 text-white' : 'border-amber-200 bg-white hover:bg-amber-50 text-amber-700'}`}
                                >
                                  2週間おき
                                </button>
                                <button
                                  type="button"
                                  disabled={supplyRecurringWeekday === null}
                                  onClick={() => handleApplyRecurringSupplyDates(30, Math.max(0, s.allocated - s.scheduledUseDates.length))}
                                  className={`flex-1 text-[10px] font-bold py-1 rounded border disabled:text-slate-300 disabled:bg-slate-50 disabled:cursor-not-allowed ${supplyRecurringIntervalDays === 30 ? 'bg-amber-600 border-amber-600 text-white' : 'border-amber-200 bg-white hover:bg-amber-50 text-amber-700'}`}
                                >
                                  30日おき
                                </button>
                              </div>
                            </div>
                            <div className="flex justify-between mt-1.5">
                              <button type="button" onClick={() => { setOpenSupplyDateCalendarKey(null); setSupplyDateDraftSelection([]); }} className="text-[10px] font-bold text-slate-500 hover:text-slate-700">キャンセル</button>
                              <button type="button" onClick={() => handleSaveSupplyUseDates(COMMON_SUPPLY_ID, s.id)} disabled={supplyDateDraftSelection.length === 0} className="text-[10px] font-bold text-white bg-amber-600 hover:bg-amber-700 disabled:bg-slate-300 rounded px-2 py-1">💾 保存</button>
                            </div>
                          </div>
                        )}
                      </td>
                      <td className={`text-center font-bold text-amber-900 ${supplyPrintHideStock ? 'no-print' : ''}`}>
                        <input
                          type="number"
                          value={s.stock}
                          onChange={e => handleUpdateSupply(COMMON_SUPPLY_ID, s.id, 'stock', parseInt(e.target.value, 10) || 0)}
                          title="在庫は直接書き換えられます"
                          className="w-10 border rounded text-center p-0.5 font-bold text-amber-900"
                        /><span className={(s.unit || '個') === '箱' ? 'text-blue-600' : ''}>{s.unit || '個'}</span>
                      </td>
                      <td className="no-print text-center">
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`「${s.name}」を物品管理から削除しますか？`)) handleRemoveSupplyItem(COMMON_SUPPLY_ID, s.id);
                          }}
                          title="使用がなくなった物品を削除"
                          className="opacity-0 group-hover/supplyrow:opacity-100 transition-opacity text-slate-300 hover:text-rose-500 font-bold px-1 leading-none"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
                <button
                  type="button"
                  onClick={() => handleAddSupplyItemForPatient(COMMON_SUPPLY_ID)}
                  className="no-print text-[10px] text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg px-2 py-1 font-bold"
                >
                  ＋ 物品を追加
                </button>
              </div>
            )}
            {shownPatients.map(p => (
              <div key={p.id} className="p-4 space-y-2">
                <div className={`font-bold ${getNameColorClass(p.gender)}`}>{p.room} {p.name}<LastEditedHint p={p} /> {p.hasBalloon && <span className="text-xs font-normal text-amber-600">(バルンあり 次回:{p.nextExchangeDate})</span>}</div>
                {p.hasBalloon && (
                  <div className="flex space-x-2 no-print">
                    <button onClick={() => setTwoWeeksInterval(p.id)} className="bg-amber-100 px-2 py-0.5 rounded text-[10px] font-bold">2週間後をセット</button>
                    <button onClick={() => handleExchangeToggle(p.id)} className={`px-2 py-0.5 rounded text-[10px] font-bold border ${p.isExchangeChecked ? 'bg-emerald-600 text-white' : 'bg-white text-rose-600 border-rose-200'}`}>{p.isExchangeChecked ? '☑ 交換済' : '☐ 交換実施'}</button>
                  </div>
                )}
                <table className="w-full text-xs text-left">
                  <thead><tr className="bg-slate-50 border-b"><th>物品名</th><th className="text-center w-32">定数</th><th className={`text-center w-24 ${supplyPrintHideStock ? 'no-print' : ''}`}>在庫</th><th className="no-print w-6"></th></tr></thead>
                  <tbody className="divide-y">{p.supplies.map(s => (
                    <tr key={s.id} className="group/supplyrow">
                      <td>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleOpenSupplyItemEditor(p.id, s.id, s.name, s.allocated, s.unit || '個', s.kind || '定数')}
                            title="クリックして物品一覧から変更（書き間違いの修正など）"
                            className="hover:underline hover:text-amber-700 text-left"
                          >
                            📦 {s.name}
                          </button>
                          <button
                            type="button"
                            onClick={() => setExpandedSupplyMemoIds(prev => {
                              const next = new Set(prev);
                              if (next.has(s.id)) next.delete(s.id); else next.add(s.id);
                              return next;
                            })}
                            title="メモ欄を開く・閉じる"
                            className="no-print shrink-0 text-amber-500 hover:text-amber-700 font-bold text-xs px-1"
                          >
                            ＋
                          </button>
                        </div>
                        {(expandedSupplyMemoIds.has(s.id) || (s.memo || '').trim() !== '') && (
                          <input
                            type="text"
                            value={s.memo || ''}
                            onChange={e => handleUpdateSupplyMemo(p.id, s.id, e.target.value)}
                            placeholder="用途：必要定数変更および追加調達依頼内容"
                            className="w-full mt-1 p-1 border rounded text-[10px] text-slate-600"
                          />
                        )}
                      </td>
                      <td className="text-center relative align-top py-2">
                        <div className="flex items-center justify-center gap-1">
                          {(s.kind || '定数') === '臨時' && <span className="text-[10px] font-bold text-rose-600 print:text-sm print:px-1.5 print:py-0.5 print:border-2 print:border-rose-600 print:rounded print:bg-rose-50">臨時</span>}
                          {editingSupplyAllocatedKey === `${p.id}::${s.id}` ? (
                            <input
                              type="number"
                              autoFocus
                              value={editingSupplyAllocatedValue}
                              onChange={e => setEditingSupplyAllocatedValue(e.target.value)}
                              onBlur={e => handleCommitEditSupplyAllocated(p.id, s.id, s.allocated, e.currentTarget.getBoundingClientRect())}
                              onKeyDown={e => { if (e.key === 'Enter') handleCommitEditSupplyAllocated(p.id, s.id, s.allocated, e.currentTarget.getBoundingClientRect()); }}
                              className="w-10 border rounded text-center p-0.5"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleStartEditSupplyAllocated(p.id, s.id, s.allocated)}
                              title="クリックして定数を変更"
                              className="w-10 border rounded text-center p-0.5 bg-white hover:bg-amber-50 font-bold text-slate-700"
                            >
                              {s.allocated}
                            </button>
                          )}{s.unit || '個'}
                          <button
                            type="button"
                            onClick={() => openSupplyDateCalendar(p.id, s.id)}
                            title="使用予定日を追加する（追加後、左のレ点にチェックすると在庫が1減ります）"
                            className="no-print shrink-0 text-amber-600 hover:text-amber-800"
                          >
                            🗓️
                          </button>
                        </div>
                        {s.scheduledUseDates.length > 0 && (
                          <div className="no-print flex flex-wrap justify-center gap-1 mt-1">
                            {[...s.scheduledUseDates].sort((a, b) => a.date.localeCompare(b.date)).map((entry, entryIdx) => {
                              // 🚨 定数の件数（s.allocated）を超えた分（最初に指定した日にち以外）は赤字で警告表示する
                              const isOverLimit = entryIdx >= s.allocated;
                              return (
                                <span
                                  key={entry.date}
                                  className={`inline-flex items-center text-[9px] font-bold px-1 rounded ${
                                    isOverLimit
                                      ? (entry.applied ? 'text-rose-400 line-through' : 'text-rose-600 bg-rose-50 border border-rose-300')
                                      : (entry.applied ? 'text-slate-400 line-through' : 'text-amber-700 bg-amber-50 border border-amber-200')
                                  }`}
                                >
                                  <button
                                    type="button"
                                    onClick={() => handleToggleSupplyUseDateChecked(p.id, s.id, entry.date)}
                                    title="チェックすると在庫を1減らします（チェックを外すと在庫を1戻します）"
                                    className={`mr-0.5 w-3 h-3 rounded-sm border flex items-center justify-center leading-none ${
                                      isOverLimit
                                        ? (entry.applied ? 'bg-rose-600 border-rose-600 text-white' : 'bg-white border-rose-400 text-transparent')
                                        : (entry.applied ? 'bg-amber-600 border-amber-600 text-white' : 'bg-white border-amber-300 text-transparent')
                                    }`}
                                  >
                                    ✓
                                  </button>
                                  {formatDateShort(entry.date)}
                                  {!entry.applied && (
                                    <button type="button" onClick={() => handleRemoveSupplyUseDate(p.id, s.id, entry.date)} className="ml-0.5 text-rose-400 hover:text-rose-600">×</button>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        )}
                        {/* 🖨️ 印刷時：定数の項目はカレンダーで選んだ日を「▢9/7」の形で表記し、定数の数と
                            カレンダーで作成した日の数が一致するか一目で確認できるようにする */}
                        {(s.kind || '定数') === '定数' && s.scheduledUseDates.length > 0 && (
                          <div className="print-only flex flex-wrap justify-center gap-1 mt-1 text-[9px] font-bold text-slate-700">
                            {[...s.scheduledUseDates].sort((a, b) => a.date.localeCompare(b.date)).map(entry => (
                              <span key={entry.date}>▢{formatDateShort(entry.date)}</span>
                            ))}
                          </div>
                        )}
                        {openSupplyDateCalendarKey === `${p.id}::${s.id}` && (
                          <div className="absolute z-30 mt-1 left-1/2 -translate-x-1/2 bg-white border border-amber-200 rounded-xl shadow-lg p-2 w-56 text-left">
                            <div className="flex items-center justify-between mb-1.5">
                              <button type="button" onClick={() => shiftSupplyDateCalendarMonth(-1)} className="w-7 h-7 rounded-lg border border-amber-200 bg-white hover:bg-amber-50 text-xs font-bold">◀</button>
                              <div className="text-xs font-bold text-amber-900">
                                {(() => {
                                  const [y, m] = (supplyDateCalendarMonth || getTodayISO().slice(0, 7)).split('-');
                                  return `${y}年${Number(m)}月`;
                                })()}
                              </div>
                              <button type="button" onClick={() => shiftSupplyDateCalendarMonth(1)} className="w-7 h-7 rounded-lg border border-amber-200 bg-white hover:bg-amber-50 text-xs font-bold">▶</button>
                            </div>
                            <div className="text-[9px] text-slate-400 mb-1">複数の日にちを選んでから保存できます</div>
                            <div className="grid grid-cols-7 gap-0.5 text-center">
                              {JST_WEEKDAYS.map(w => (
                                <div key={w} className="text-[9px] font-bold text-slate-400">{w}</div>
                              ))}
                              {getCalendarMonthCells(supplyDateCalendarMonth || getTodayISO().slice(0, 7)).map((iso, idx) => {
                                if (!iso) return <div key={idx} />;
                                const isSelected = supplyDateDraftSelection.includes(iso);
                                const isToday = getTodayISO() === iso;
                                return (
                                  <button
                                    key={iso}
                                    type="button"
                                    onClick={() => toggleSupplyDateDraftSelection(iso, Math.max(0, s.allocated - s.scheduledUseDates.length))}
                                    className={`w-6 h-6 rounded text-[10px] font-bold flex items-center justify-center ${isSelected ? 'bg-amber-600 text-white' : isToday ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'hover:bg-amber-50 text-slate-700'}`}
                                  >
                                    {Number(iso.slice(8, 10))}
                                  </button>
                                );
                              })}
                            </div>
                            {/* 🗓️ 曜日＋間隔での一括選択：例「月」＋「2週間おき」→表示中の月の対象曜日を2週間おきに自動選択 */}
                            <div className="mt-1.5 pt-1.5 border-t border-slate-100">
                              <div className="grid grid-cols-7 gap-0.5">
                                {JST_WEEKDAYS.map((w, idx) => (
                                  <button
                                    key={w}
                                    type="button"
                                    onClick={() => setSupplyRecurringWeekday(idx)}
                                    className={`text-[9px] font-bold py-1 rounded ${supplyRecurringWeekday === idx ? 'bg-amber-600 text-white' : 'bg-slate-50 text-slate-600 hover:bg-amber-50'}`}
                                  >
                                    {w}
                                  </button>
                                ))}
                              </div>
                              <div className="flex gap-1 mt-1">
                                <button
                                  type="button"
                                  disabled={supplyRecurringWeekday === null}
                                  onClick={() => handleApplyRecurringSupplyDates(14, Math.max(0, s.allocated - s.scheduledUseDates.length))}
                                  className={`flex-1 text-[10px] font-bold py-1 rounded border disabled:text-slate-300 disabled:bg-slate-50 disabled:cursor-not-allowed ${supplyRecurringIntervalDays === 14 ? 'bg-amber-600 border-amber-600 text-white' : 'border-amber-200 bg-white hover:bg-amber-50 text-amber-700'}`}
                                >
                                  2週間おき
                                </button>
                                <button
                                  type="button"
                                  disabled={supplyRecurringWeekday === null}
                                  onClick={() => handleApplyRecurringSupplyDates(30, Math.max(0, s.allocated - s.scheduledUseDates.length))}
                                  className={`flex-1 text-[10px] font-bold py-1 rounded border disabled:text-slate-300 disabled:bg-slate-50 disabled:cursor-not-allowed ${supplyRecurringIntervalDays === 30 ? 'bg-amber-600 border-amber-600 text-white' : 'border-amber-200 bg-white hover:bg-amber-50 text-amber-700'}`}
                                >
                                  30日おき
                                </button>
                              </div>
                            </div>
                            <div className="flex justify-between mt-1.5">
                              <button type="button" onClick={() => { setOpenSupplyDateCalendarKey(null); setSupplyDateDraftSelection([]); }} className="text-[10px] font-bold text-slate-500 hover:text-slate-700">キャンセル</button>
                              <button type="button" onClick={() => handleSaveSupplyUseDates(p.id, s.id)} disabled={supplyDateDraftSelection.length === 0} className="text-[10px] font-bold text-white bg-amber-600 hover:bg-amber-700 disabled:bg-slate-300 rounded px-2 py-1">💾 保存</button>
                            </div>
                          </div>
                        )}
                      </td>
                      <td className={`text-center font-bold text-amber-900 ${supplyPrintHideStock ? 'no-print' : ''}`}>
                        <input
                          type="number"
                          value={s.stock}
                          onChange={e => handleUpdateSupply(p.id, s.id, 'stock', parseInt(e.target.value, 10) || 0)}
                          title="在庫は直接書き換えられます"
                          className="w-10 border rounded text-center p-0.5 font-bold text-amber-900"
                        /><span className={(s.unit || '個') === '箱' ? 'text-blue-600' : ''}>{s.unit || '個'}</span>
                      </td>
                      <td className="no-print text-center">
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`「${s.name}」を物品管理から削除しますか？`)) handleRemoveSupplyItem(p.id, s.id);
                          }}
                          title="使用がなくなった物品を削除"
                          className="opacity-0 group-hover/supplyrow:opacity-100 transition-opacity text-slate-300 hover:text-rose-500 font-bold px-1 leading-none"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
                <button
                  type="button"
                  onClick={() => handleAddSupplyItemForPatient(p.id)}
                  className="no-print text-[10px] text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg px-2 py-1 font-bold"
                >
                  ＋ 物品を追加
                </button>
              </div>
            ))}
          </div>

          {/* 📊 TOTAL：氏名・共通物品を問わず、物品名ごとに定数を合計する（定数と臨時は別々に集計）。
              集計する物品が1件も無い時は、紛らわしいので表示しない */}
          {(fixedSupplyTotals.length > 0 || temporarySupplyTotals.length > 0) && (
          <div className="bg-white border border-slate-200 shadow-md p-4">
            <div className="font-black text-slate-900 text-base mb-2">
              {(() => {
                // 📅 上部の「作成日」と食い違わないよう、請求物品の月もbillingMonthではなく
                //    作成日（西暦・月まで）から表記する
                const creationMonth = supplyItemCreationDate || getTodayISO();
                const [y, m] = creationMonth.split('-');
                return `${y}年${parseInt(m, 10)}月請求物品`;
              })()}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 divide-y divide-black sm:divide-y-0 sm:divide-x sm:divide-black">
              <div className="sm:pr-4">
                <div className="text-xs font-bold text-slate-500 mb-1">定数</div>
                {fixedSupplyTotals.length === 0 ? (
                  <div className="text-xs text-slate-400">物品がありません</div>
                ) : (
                  <ul className="text-xs space-y-0.5">
                    {fixedSupplyTotals.map(t => (
                      <li key={`${t.name}__${t.unit}`} className="flex justify-between border-b border-dashed border-slate-100 py-0.5">
                        <span>{t.name}</span>
                        <span className="font-bold">{t.total}<span className={t.unit === '箱' ? 'text-blue-600' : ''}>{t.unit}</span></span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="sm:pl-4 pt-3 sm:pt-0">
                <div className="text-xs font-bold text-rose-500 mb-1">臨時</div>
                {temporarySupplyTotals.length === 0 ? (
                  <div className="text-xs text-slate-400">物品がありません</div>
                ) : (
                  <ul className="text-xs space-y-0.5">
                    {temporarySupplyTotals.map(t => (
                      <li key={`${t.name}__${t.unit}`} className="flex justify-between border-b border-dashed border-slate-100 py-0.5">
                        <span>{t.name}</span>
                        <span className="font-bold">{t.total}<span className={t.unit === '箱' ? 'text-blue-600' : ''}>{t.unit}</span></span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-dashed border-slate-200">
              {/* 📝 定期は月（billingMonth）ごと、臨時は「作成日」の日付ごとにメモを分ける。
                  同じ月でも日にちが違う臨時のページには反映されないようにするため */}
              {(() => {
                const memoKey = supplyNewCreationKind === '臨時'
                  ? (supplyItemCreationDate || getTodayISO())
                  : (supplyItemCreationDate || getTodayISO()).slice(0, 7);
                return (
                  <>
                    <div className="text-[10px] font-bold text-slate-500 mb-1 no-print">メモ</div>
                    <textarea
                      value={supplyBillingMemoByMonth[memoKey] || ''}
                      onChange={e => {
                        const value = e.target.value;
                        setSupplyBillingMemoByMonth(prev => {
                          const next = { ...prev, [memoKey]: value };
                          if (typeof window !== 'undefined') localStorage.setItem('oncall_supply_billing_memo_by_month', JSON.stringify(next));
                          return next;
                        });
                      }}
                      placeholder="クリニックへの伝達事項などを自由に記載できます"
                      rows={2}
                      className="no-print w-full p-1.5 border rounded-lg text-xs resize-y"
                    />
                    {(supplyBillingMemoByMonth[memoKey] || '').trim() && (
                      <div className="print-only text-xs whitespace-pre-wrap">{supplyBillingMemoByMonth[memoKey]}</div>
                    )}
                  </>
                );
              })()}
            </div>
            {/* 📦 請求物品の枠の左下に、臨時物品の最後に保存した日時・実施者を表示する */}
            {supplyTemporaryLastSavedAt && (
              <div className="no-print text-left text-[10px] text-rose-700/70 mt-3 pt-3 border-t border-dashed border-slate-200">
                📅 最終保存：<span className="font-bold">{supplyTemporaryLastSavedAt}</span>　👤 {supplyTemporaryLastSavedBy || '不明なユーザー'}
              </div>
            )}
          </div>
          )}

          {/* 🗑️ 物品管理の右下に常に表示する削除ボタン。今画面に表示されている入居者・共通物品の
              物品データを、保存済みかどうかを問わず本当に消去する（押した時点で確定・元に戻せない） */}
          <div className="no-print text-right">
            <button
              type="button"
              onClick={() => {
                if (window.confirm('この画面の操作を削除しますか？（保存済みのデータも含めて元に戻せません）')) {
                  const emptyDraft: { patientSupplies: Record<string, SupplyItem[]>; commonSupplies: SupplyItem[] } = {
                    patientSupplies: Object.fromEntries(patients.map(p => [p.id, []])),
                    commonSupplies: [],
                  };
                  setPatients(prev => prev.map(p => p.supplies.length === 0 ? p : touchLastEdited({ ...p, supplies: [] })));
                  setCommonSupplies([]);
                  setSupplyDraft(emptyDraft);
                  setSupplyNewItemDraft(null);
                  setIsSupplyPatientPickerOpen(false);
                  setSupplyCatalogView(false);
                  setIsSupplyKindPickerOpen(false);
                  setIsSupplyNewCreationOpen(false);
                }
              }}
              className="text-xs font-bold text-rose-600 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-xl px-3 py-1.5"
            >
              🗑️ 削除
            </button>
          </div>

          {/* 📦 物品管理に追加する入居者を選ぶピッカー：物品名がまだ無い人だけが候補に出る。
              選ぶと物品名の入力画面に切り替わり、物品名が保存されて初めて一覧に名前が現れる */}
          {isSupplyPatientPickerOpen && (() => {
            const draftPatient = supplyNewItemDraft ? patients.find(pt => pt.id === supplyNewItemDraft.patientId) : null;
            return (
            <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 no-print">
              <div className="bg-white rounded-3xl border border-amber-200 shadow-2xl w-full max-w-sm max-h-[80vh] overflow-hidden flex flex-col">
                <div className="bg-amber-700 p-4 text-white flex justify-between items-center shrink-0">
                  <div className="text-sm font-bold">
                    {supplyCatalogView !== false
                      ? (supplyCatalogView === null ? '📦 物品タイトルを選択' : `📦「${supplyCatalogView}」の物品名を選択`)
                      : (supplyNewItemDraft
                        ? (supplyNewItemDraft.patientId === COMMON_SUPPLY_ID ? '📦 共通物品の物品名を入力' : `📦 ${draftPatient?.room}号室 ${draftPatient?.name} の物品名を入力`)
                        : '📦 物品管理に追加する方を選択')}
                  </div>
                  <button onClick={() => { setIsSupplyPatientPickerOpen(false); setSupplyNewItemDraft(null); setSupplyCatalogView(false); setIsSupplyKindPickerOpen(false); }} className="text-2xl font-normal hover:text-rose-200">✕</button>
                </div>
                {supplyCatalogView !== false ? (
                  <div className="p-3 overflow-y-auto flex-1">
                    <button
                      onClick={() => setSupplyCatalogView(supplyCatalogView === null ? false : null)}
                      className="text-xs text-amber-700 font-bold mb-2 hover:underline"
                    >
                      ← {supplyCatalogView === null ? '物品名の入力に戻る' : '物品タイトル一覧に戻る'}
                    </button>
                    {supplyCatalogView === null && (
                      <div className="mb-3 p-2 border border-dashed border-amber-200 rounded-xl space-y-1.5">
                        <div className="text-[10px] font-bold text-amber-700">✍️ 候補にない物品を手動で記載</div>
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            value={supplyNewItemDraft?.name || ''}
                            onChange={e => setSupplyNewItemDraft(prev => prev ? { ...prev, name: e.target.value } : prev)}
                            placeholder="物品名"
                            className="flex-1 min-w-0 p-1.5 border rounded-lg text-xs"
                          />
                          <input
                            type="number"
                            value={supplyNewItemDraft?.allocated || ''}
                            onChange={e => setSupplyNewItemDraft(prev => prev ? { ...prev, allocated: e.target.value } : prev)}
                            placeholder="定数"
                            className="w-16 shrink-0 p-1.5 border rounded-lg text-xs"
                          />
                          <button
                            type="button"
                            onClick={() => setSupplyCatalogView(false)}
                            disabled={!supplyNewItemDraft?.name.trim()}
                            className="text-[10px] bg-amber-50 hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed text-amber-700 border border-amber-200 rounded-lg px-2 py-1.5 font-bold shrink-0"
                          >
                            ＋追加
                          </button>
                        </div>
                      </div>
                    )}
                    {supplyCatalogView === null ? (
                      SUPPLY_CATALOG.map(cat => (
                        <button
                          key={cat.title}
                          onClick={() => setSupplyCatalogView(cat.title)}
                          className="w-full text-left px-3 py-2 rounded-xl hover:bg-amber-50 font-bold text-slate-800 border-b border-slate-100"
                        >
                          （{cat.title}）
                        </button>
                      ))
                    ) : (
                      SUPPLY_CATALOG.find(c => c.title === supplyCatalogView)?.items.map(item => (
                        <button
                          key={item}
                          onClick={() => {
                            setSupplyNewItemDraft(prev => prev ? { ...prev, name: item } : prev);
                            setSupplyCatalogView(false);
                          }}
                          className="w-full text-left px-3 py-2 rounded-xl hover:bg-amber-50 text-slate-700 border-b border-slate-100"
                        >
                          {item}
                        </button>
                      ))
                    )}
                  </div>
                ) : !supplyNewItemDraft ? (
                  <div className="p-3 overflow-y-auto flex-1">
                    {/* 📦 特定の入居者に紐づかない、施設共通の物品。クリックすると入居者と同じ物品名選択の流れに入る */}
                    <button
                      onClick={() => handleAddSupplyItemForPatient(COMMON_SUPPLY_ID)}
                      className="w-full text-left px-3 py-2 rounded-xl hover:bg-amber-50 font-bold text-amber-700 border-b border-slate-100 mb-1"
                    >
                      📦 共通物品
                    </button>
                    {addablePatients.length === 0 && (
                      <div className="text-xs text-slate-400 text-center py-8">追加できる入居者がいません（部屋図の入居者は全員すでに物品名が登録済みです）</div>
                    )}
                    {addablePatients.map(p => (
                      <button
                        key={p.id}
                        onClick={() => handleSelectSupplyPatient(p.id)}
                        className={`w-full text-left px-3 py-2 rounded-xl hover:bg-amber-50 font-bold ${getNameColorClass(p.gender)}`}
                      >
                        {p.room}号室 {p.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="p-4 space-y-3">
                    <div>
                      <label className="text-xs font-bold text-slate-500">物品名</label>
                      <div className="flex items-center gap-1 mt-1">
                        <input
                          type="text"
                          value={supplyNewItemDraft.name}
                          onChange={e => setSupplyNewItemDraft(prev => prev ? { ...prev, name: e.target.value } : prev)}
                          placeholder="物品名を入力"
                          className="flex-1 min-w-0 p-1.5 border rounded-lg bg-white"
                        />
                        <button
                          type="button"
                          onClick={() => setSupplyCatalogView(null)}
                          className="text-[10px] bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 rounded-lg px-2 py-1.5 font-bold shrink-0"
                        >
                          一覧から選ぶ
                        </button>
                      </div>
                    </div>
                    <div>
                      <div className="relative inline-block">
                        <button
                          type="button"
                          onClick={() => setIsSupplyKindPickerOpen(prev => !prev)}
                          title="クリックして「定数」「臨時」を選べます"
                          className="text-xs font-bold text-amber-700 underline decoration-dotted"
                        >
                          {supplyNewItemDraft.kind}
                        </button>
                        {isSupplyKindPickerOpen && (
                          <div className="absolute z-20 mt-1 bg-white border border-amber-200 rounded-lg shadow-lg w-24 overflow-hidden">
                            {(['定数', '臨時'] as const).map(k => (
                              <button
                                key={k}
                                type="button"
                                onClick={() => {
                                  setSupplyNewItemDraft(prev => prev ? { ...prev, kind: k } : prev);
                                  setIsSupplyKindPickerOpen(false);
                                }}
                                className={`w-full text-left px-3 py-1.5 text-xs font-bold ${supplyNewItemDraft.kind === k ? 'bg-amber-600 text-white' : 'text-slate-700 hover:bg-amber-50'}`}
                              >
                                {k}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 mt-1">
                        <input
                          type="number"
                          value={supplyNewItemDraft.allocated}
                          onChange={e => setSupplyNewItemDraft(prev => prev ? { ...prev, allocated: e.target.value } : prev)}
                          placeholder="0"
                          className="flex-1 min-w-0 p-1.5 border rounded-lg"
                        />
                        <div className="flex shrink-0 border rounded-lg overflow-hidden">
                          {(['個', '箱'] as const).map(u => (
                            <button
                              key={u}
                              type="button"
                              onClick={() => setSupplyNewItemDraft(prev => prev ? { ...prev, unit: u } : prev)}
                              className={`px-3 py-1.5 text-xs font-bold ${supplyNewItemDraft.unit === u ? 'bg-amber-600 text-white' : 'bg-white text-slate-600 hover:bg-amber-50'}`}
                            >
                              {u}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button onClick={() => { setSupplyNewItemDraft(null); setIsSupplyKindPickerOpen(false); }} className="flex-1 bg-white text-slate-600 border border-slate-300 hover:bg-slate-50 font-bold px-4 py-2 rounded-xl">戻る</button>
                      <button onClick={handleSaveSupplyNewItem} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-4 py-2 rounded-xl shadow-md">💾 保存</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            );
          })()}

        </div>
        );
      })()}


      {/* 📜 患者タイムライン：この患者の往診記録だけを新しい順に並べる（何もなければほぼ空になる） */}
      {timelinePatientId && (() => {
        const p = patients.find(pt => pt.id === timelinePatientId);
        if (!p) return null;
        const records = [...p.visitHistory].sort((a, b) => b.timestamp - a.timestamp);

        return (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 no-print">
            <div className="bg-white rounded-3xl border border-emerald-100 shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">

              <div className="bg-emerald-800 p-4 text-white flex justify-between items-center shrink-0">
                <div>
                  <div className="text-xs opacity-80">📜 時系列（既往歴）</div>
                  <div className="text-base font-bold mt-0.5">{p.room}号室 {p.name}</div>
                  <div className="text-[10px] opacity-70 mt-0.5">往診サイクルごとの記録を新しい順に表示（変化がなければ記録はほぼ残りません）</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { handleCloseTimeline(); handleOpenEmergencyModal(p); }}
                    className="no-print text-[11px] font-bold bg-white/15 hover:bg-white/25 border border-white/30 rounded-lg px-2.5 py-1.5 whitespace-nowrap"
                  >
                    🚨 緊急時対応サマリー
                  </button>
                  <button onClick={handleCloseTimeline} className="text-2xl font-normal hover:text-rose-200">✕</button>
                </div>
              </div>

              <div className="overflow-y-auto p-4 space-y-3">
                {records.length === 0 && (
                  <p className="text-xs text-slate-400 text-center py-6">まだ記録がありません（次回往診サイクル開始時から記録が積み上がります）。</p>
                )}
                {records.map(record => {
                  const reportText = record.reportToDoctor || record.doctorMemo || '';
                  const isImportant = highlightTimelineText(reportText) || highlightTimelineText(record.doctorOrder);
                  const draftValue = timelineSummaryDrafts[record.id] ?? record.timelineSummary ?? '';
                  const isLoading = !!timelineSummaryLoading[record.id];
                  return (
                    <div key={record.id} className={`border rounded-2xl p-3 ${isImportant ? 'border-rose-300 bg-rose-50/50' : 'border-slate-200 bg-white'}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className={`text-xs font-bold ${isImportant ? 'text-rose-700' : 'text-slate-600'}`}>
                          {isImportant && '⚠️ '}{record.date}
                        </span>
                        <span className="text-[10px] text-slate-400">記録者：{record.lastEditedBy || '不明'}</span>
                      </div>
                      {reportText && (
                        <div className={`text-xs whitespace-pre-wrap ${isImportant ? 'text-rose-800 font-bold' : 'text-slate-700'}`}>
                          {reportText}
                        </div>
                      )}
                      {record.doctorOrder && (
                        <div className="text-[10px] text-slate-500 mt-1.5 pt-1.5 border-t border-dashed border-slate-200 whitespace-pre-wrap">
                          <span className="font-bold">指示内容：</span>{record.doctorOrder}
                        </div>
                      )}

                      {/* ✨ AI要約：①②の内容から簡潔な要約を作り、看護師が編集・保存できる */}
                      <div className="mt-2 pt-2 border-t border-dashed border-slate-200">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] font-bold text-emerald-700">📝 要約メモ</span>
                          {record.timelineSummaryEditedBy && (
                            <span className="text-[9px] text-slate-400">👤 {record.timelineSummaryEditedBy}　📅 {record.timelineSummaryEditedAt}</span>
                          )}
                        </div>
                        <textarea
                          value={draftValue}
                          onChange={e => handleTimelineSummaryDraftChange(record.id, e.target.value)}
                          placeholder="「✨ AIで要約する」を押すか、直接ここに要点を書いてください"
                          rows={2}
                          className="w-full p-1.5 border border-emerald-200 rounded-lg text-[11px] bg-emerald-50/30"
                        />
                        <div className="flex gap-1.5 mt-1">
                          <button
                            type="button"
                            onClick={() => handleGenerateTimelineSummary(record.id, record.reportToDoctor, record.doctorMemo)}
                            disabled={isLoading}
                            className="no-print text-[10px] font-bold bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-lg px-2 py-1 disabled:opacity-50"
                          >
                            {isLoading ? '⏳ 要約中...' : '✨ AIで要約する'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSaveTimelineSummary(p.id, record.id)}
                            className="no-print text-[10px] font-bold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg px-2 py-1"
                          >
                            💾 保存
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 🗓️ 往診日 決定・保存モーダル */}
      {isVisitDateEditorOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 no-print">
          <div className="bg-white rounded-3xl border border-pink-100 shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="bg-pink-700 p-4 text-white">
              <div className="text-base font-bold flex justify-between items-center">
                <span>🗓️ 診療日を決定</span>
                <button onClick={() => setIsVisitDateEditorOpen(false)} className="text-xl font-normal hover:text-rose-200">✕</button>
              </div>
            </div>

            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <button type="button" onClick={() => shiftVisitDateDraft(-1)} className="w-11 h-11 shrink-0 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 active:bg-slate-100 text-lg font-bold">◀</button>
                <div className="flex-1 text-center text-lg font-bold text-pink-700 bg-pink-50 rounded-xl py-2.5">
                  {visitDateDraft || '未設定'}
                </div>
                <button type="button" onClick={() => shiftVisitDateDraft(1)} className="w-11 h-11 shrink-0 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 active:bg-slate-100 text-lg font-bold">▶</button>
              </div>
              {/* 🗓️ カレンダー：日付をクリックすると直接その日が選択される */}
              <div className="border border-slate-200 rounded-xl p-2">
                <div className="flex items-center justify-between mb-1.5">
                  <button type="button" onClick={() => shiftVisitDateCalendarMonth(-1)} className="w-8 h-8 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 active:bg-slate-100 text-sm font-bold">◀</button>
                  <div className="text-sm font-bold text-slate-700">
                    {(() => {
                      const [y, m] = (visitDateCalendarMonth || getTodayISO().slice(0, 7)).split('-');
                      return `${y}年${Number(m)}月`;
                    })()}
                  </div>
                  <button type="button" onClick={() => shiftVisitDateCalendarMonth(1)} className="w-8 h-8 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 active:bg-slate-100 text-sm font-bold">▶</button>
                </div>
                <div className="grid grid-cols-7 gap-1 text-center">
                  {JST_WEEKDAYS.map(w => (
                    <div key={w} className="text-[10px] font-bold text-slate-400 py-1">{w}</div>
                  ))}
                  {getCalendarMonthCells(visitDateCalendarMonth || getTodayISO().slice(0, 7)).map((iso, idx) => {
                    if (!iso) return <div key={idx} />;
                    const isSelected = parseJapaneseDateToISO(visitDateDraft) === iso;
                    const isToday = getTodayISO() === iso;
                    return (
                      <button
                        key={iso}
                        type="button"
                        onClick={() => setVisitDateDraft(formatISOToJapaneseDate(iso))}
                        className={`w-8 h-8 rounded-lg text-xs font-bold flex items-center justify-center transition-colors ${
                          isSelected
                            ? 'bg-pink-600 text-white'
                            : isToday
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'hover:bg-pink-50 text-slate-700'
                        }`}
                      >
                        {Number(iso.slice(8, 10))}
                      </button>
                    );
                  })}
                </div>
              </div>
              <button
                type="button"
                onClick={handleSaveVisitDate}
                className="w-full bg-pink-600 hover:bg-pink-700 active:bg-pink-800 text-white font-bold py-3 rounded-xl shadow-md transition-all"
              >
                💾 保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🗓️ 緊急時対応サマリーシート「最終検査日」のカレンダー：日付をクリックして選択できる（手動での書き換えも引き続き可） */}
      {isLastTestDateCalendarOpen && summaryDraft && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-[60] p-4 no-print">
          <div className="bg-white rounded-3xl border border-purple-100 shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="bg-purple-800 p-4 text-white">
              <div className="text-base font-bold flex justify-between items-center">
                <span>🗓️ 最終検査日を選択</span>
                <button onClick={() => setIsLastTestDateCalendarOpen(false)} className="text-xl font-normal hover:text-rose-200">✕</button>
              </div>
            </div>

            <div className="p-4 space-y-4">
              <div className="text-center text-lg font-bold text-purple-700 bg-purple-50 rounded-xl py-2.5">
                {summaryDraft.summary.lastTestDate || '未設定'}
              </div>
              <div className="border border-slate-200 rounded-xl p-2">
                <div className="flex items-center justify-between mb-1.5">
                  <button type="button" onClick={() => shiftLastTestDateCalendarMonth(-1)} className="w-8 h-8 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 active:bg-slate-100 text-sm font-bold">◀</button>
                  <div className="text-sm font-bold text-slate-700">
                    {(() => {
                      const [y, m] = (lastTestDateCalendarMonth || getTodayISO().slice(0, 7)).split('-');
                      return `${y}年${Number(m)}月`;
                    })()}
                  </div>
                  <button type="button" onClick={() => shiftLastTestDateCalendarMonth(1)} className="w-8 h-8 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 active:bg-slate-100 text-sm font-bold">▶</button>
                </div>
                <div className="grid grid-cols-7 gap-1 text-center">
                  {JST_WEEKDAYS.map(w => (
                    <div key={w} className="text-[10px] font-bold text-slate-400 py-1">{w}</div>
                  ))}
                  {getCalendarMonthCells(lastTestDateCalendarMonth || getTodayISO().slice(0, 7)).map((iso, idx) => {
                    if (!iso) return <div key={idx} />;
                    const isSelected = parseJapaneseDateToISO(summaryDraft.summary.lastTestDate) === iso;
                    const isToday = getTodayISO() === iso;
                    return (
                      <button
                        key={iso}
                        type="button"
                        onClick={() => handleSelectLastTestDate(iso)}
                        className={`w-8 h-8 rounded-lg text-xs font-bold flex items-center justify-center transition-colors ${
                          isSelected
                            ? 'bg-purple-600 text-white'
                            : isToday
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : 'hover:bg-purple-50 text-slate-700'
                        }`}
                      >
                        {Number(iso.slice(8, 10))}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 🗓️ ④日/期間 編集モーダル（電卓ポップアップと全く同じ確実な仕組みを使用） */}
      {editingPeriod && (() => {
        const p = patients.find(pt => pt.id === editingPeriod.patientId);
        if (!p) return null;
        const lineText = p.doctorOrder.split('\n')[editingPeriod.lineIndex] || '';

        return (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 no-print">
            <div className="bg-white rounded-3xl border border-pink-100 shadow-2xl w-full max-w-sm overflow-hidden">

              <div className="bg-pink-700 p-4 text-white">
                <div className="text-xs opacity-80">{p.room} {p.name}</div>
                <div className="text-base font-bold mt-1 flex justify-between items-center">
                  <span>🗓️ 期間の設定</span>
                  <button onClick={() => { setEditingPeriod(null); setIsEndDateMode(false); }} className="text-xl font-normal hover:text-rose-200">✕</button>
                </div>
                <div className="text-[10px] opacity-70 mt-1 truncate">{lineText}</div>
              </div>

              <div className="p-4 space-y-4">
                <div>
                  <div className="text-xs font-bold text-slate-500 mb-1.5">開始日</div>
                  <div className="flex items-center justify-between gap-2">
                    {(() => {
                      const visitIso = parseJapaneseDateToISO(nextVisitDate);
                      const isAtVisitDateLimit = !!visitIso && editingPeriod.draftStartDate <= visitIso;
                      return (
                        <button
                          type="button"
                          onClick={() => shiftPeriodDraftDate(-1)}
                          disabled={isAtVisitDateLimit}
                          title={isAtVisitDateLimit ? '診療日より前は選べません' : undefined}
                          className={`w-11 h-11 shrink-0 rounded-xl border text-lg font-bold ${isAtVisitDateLimit ? 'border-slate-200 bg-slate-100 text-slate-300 cursor-not-allowed' : 'border-slate-300 bg-white hover:bg-slate-50 active:bg-slate-100'}`}
                        >◀</button>
                      );
                    })()}
                    <div className="flex-1 text-center text-lg font-bold text-pink-700 font-mono bg-pink-50 rounded-xl py-2.5">
                      {formatDateShort(editingPeriod.draftStartDate)}
                    </div>
                    <button type="button" onClick={() => shiftPeriodDraftDate(1)} className="w-11 h-11 shrink-0 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 active:bg-slate-100 text-lg font-bold">▶</button>
                  </div>
                  <div className="flex gap-2 mt-2">
                    <button type="button" onClick={() => shiftPeriodDraftDate(-7)} className="flex-1 text-xs rounded-lg px-2 py-2 border border-slate-200 bg-white hover:bg-slate-50 active:bg-slate-100 font-bold">-7日</button>
                    <button type="button" onClick={setPeriodDraftDateToToday} className="flex-1 text-xs rounded-lg px-2 py-2 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 active:bg-emerald-200 text-emerald-700 font-bold">今日</button>
                    <button type="button" onClick={() => shiftPeriodDraftDate(7)} className="flex-1 text-xs rounded-lg px-2 py-2 border border-slate-200 bg-white hover:bg-slate-50 active:bg-slate-100 font-bold">+7日</button>
                  </div>
                  {nextVisitDate && (
                    <div className="text-[10px] text-slate-400 mt-1.5">🔒 診療日（{nextVisitDate}）より前は選べません</div>
                  )}
                  {/* 🗓️ カレンダー：日付を直接クリックして開始日を選べる */}
                  <div className="border border-slate-200 rounded-xl p-2 mt-2">
                    <div className="flex items-center justify-between mb-1.5">
                      <button type="button" onClick={() => shiftPeriodStartCalendarMonth(-1)} className="w-8 h-8 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 active:bg-slate-100 text-sm font-bold">◀</button>
                      <div className="text-sm font-bold text-slate-700">
                        {(() => {
                          const [y, m] = (periodStartCalendarMonth || getTodayISO().slice(0, 7)).split('-');
                          return `${y}年${Number(m)}月`;
                        })()}
                      </div>
                      <button type="button" onClick={() => shiftPeriodStartCalendarMonth(1)} className="w-8 h-8 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 active:bg-slate-100 text-sm font-bold">▶</button>
                    </div>
                    <div className="grid grid-cols-7 gap-1 text-center">
                      {JST_WEEKDAYS.map(w => (
                        <div key={w} className="text-[10px] font-bold text-slate-400 py-1">{w}</div>
                      ))}
                      {getCalendarMonthCells(periodStartCalendarMonth || getTodayISO().slice(0, 7)).map((iso, idx) => {
                        if (!iso) return <div key={idx} />;
                        const visitIso = parseJapaneseDateToISO(nextVisitDate);
                        const isDisabled = !!visitIso && iso < visitIso;
                        const isSelected = editingPeriod.draftStartDate === iso;
                        const isToday = getTodayISO() === iso;
                        return (
                          <button
                            key={iso}
                            type="button"
                            disabled={isDisabled}
                            onClick={() => handleSelectPeriodStartDate(iso)}
                            className={`w-8 h-8 rounded-lg text-xs font-bold flex items-center justify-center transition-colors ${
                              isDisabled
                                ? 'text-slate-200 cursor-not-allowed'
                                : isSelected
                                ? 'bg-pink-600 text-white'
                                : isToday
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                : 'hover:bg-pink-50 text-slate-700'
                            }`}
                          >
                            {Number(iso.slice(8, 10))}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* 選択内容を下部に常時表示：開始日を変えると開始日が、期間/終了日を変えると終了日が即時反映される */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-pink-100 bg-pink-50 px-3 py-2.5">
                    <div className="text-[10px] font-bold text-pink-500 mb-0.5">🗓️ 開始日</div>
                    <div className="text-base font-bold text-pink-700 font-mono">
                      {formatDateShort(editingPeriod.draftStartDate) || '未設定'}
                    </div>
                  </div>
                  <div className="rounded-xl border border-sky-100 bg-sky-50 px-3 py-2.5">
                    <div className="text-[10px] font-bold text-sky-500 mb-0.5">🗓️ 終了日</div>
                    <div className="text-base font-bold text-sky-700 font-mono">
                      {isEndDateMode
                        ? (formatDateShort(draftEndDate) || '未設定')
                        : (formatDateShort(getOrderEndDateISO(editingPeriod.draftStartDate, editingPeriod.draftDurationDays)) || '未設定')}
                    </div>
                  </div>
                </div>

                <div className="text-center text-sm font-bold text-slate-600 bg-slate-50 border border-slate-100 rounded-xl py-2">
                  日/期間へ保存される表示：
                  <span className="ml-1 text-pink-700 font-mono">
                    {isEndDateMode
                      ? `${formatDateShort(editingPeriod.draftStartDate)}～${formatDateShort(draftEndDate)}`
                      : formatOrderPeriod({ startDate: editingPeriod.draftStartDate, durationDays: editingPeriod.draftDurationDays })}
                  </span>
                </div>

                {!isEndDateMode ? (
                  <>
                    <div>
                      <div className="text-xs font-bold text-slate-500 mb-1.5">期間を選ぶと、上の「終了日」に同時に反映されます（まだ日/期間には保存されません）</div>
                      <div className="grid grid-cols-4 gap-2">
                        {[1, 5, 7, 14].map(d => (
                          <button
                            key={d}
                            type="button"
                            onClick={() => handleSelectPeriodDuration(d)}
                            className={`text-xs rounded-xl px-2 py-3 font-bold border transition-all active:scale-95 ${editingPeriod.draftDurationDays === d ? 'bg-pink-600 text-white border-pink-600' : 'bg-pink-50 hover:bg-pink-100 text-pink-700 border-pink-200'}`}
                          >
                            {d}日間
                          </button>
                        ))}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={openEndDateMode}
                      className="w-full text-xs rounded-xl px-2 py-2.5 border border-sky-200 bg-sky-50 hover:bg-sky-100 text-sky-700 font-bold"
                    >
                      🗓️ 終了日を自分で選ぶ（日数のプリセットを使わない）
                    </button>

                    <button
                      type="button"
                      onClick={handleSavePeriod}
                      className="w-full bg-pink-600 hover:bg-pink-700 active:bg-pink-800 text-white font-bold py-3 rounded-xl shadow-md transition-all"
                    >
                      💾 保存
                    </button>

                    <div className="text-[10px] text-slate-400 text-center">※保存すると、上に表示されている開始日～終了日が日/期間へ反映されます。自由な文言は閉じた状態のバッジをダブルクリックしてください</div>
                  </>
                ) : (
                  <div className="border-t border-dashed border-slate-200 pt-3 space-y-3">
                    <div className="text-xs font-bold text-slate-500">終了日（開始日以降のみ選べます）</div>
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => shiftDraftEndDate(-1)}
                        disabled={draftEndDate <= editingPeriod.draftStartDate}
                        className={`w-11 h-11 shrink-0 rounded-xl border text-lg font-bold ${draftEndDate <= editingPeriod.draftStartDate ? 'border-slate-200 bg-slate-100 text-slate-300 cursor-not-allowed' : 'border-slate-300 bg-white hover:bg-slate-50 active:bg-slate-100'}`}
                      >◀</button>
                      <div className="flex-1 text-center text-lg font-bold text-sky-700 font-mono bg-sky-50 rounded-xl py-2.5">
                        {formatDateShort(draftEndDate)}
                      </div>
                      <button type="button" onClick={() => shiftDraftEndDate(1)} className="w-11 h-11 shrink-0 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 active:bg-slate-100 text-lg font-bold">▶</button>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => shiftDraftEndDate(-7)} className="flex-1 text-xs rounded-lg px-2 py-2 border border-slate-200 bg-white hover:bg-slate-50 active:bg-slate-100 font-bold">-7日</button>
                      <button type="button" onClick={() => shiftDraftEndDate(7)} className="flex-1 text-xs rounded-lg px-2 py-2 border border-slate-200 bg-white hover:bg-slate-50 active:bg-slate-100 font-bold">+7日</button>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" onClick={closeEndDateMode} className="flex-1 text-xs rounded-xl px-2 py-2.5 border border-slate-300 bg-white hover:bg-slate-50 font-bold text-slate-600">戻る</button>
                      <button type="button" onClick={handleSaveManualEndDate} className="flex-1 text-xs rounded-xl px-2 py-2.5 border border-sky-600 bg-sky-600 hover:bg-sky-700 text-white font-bold">💾 保存</button>
                    </div>
                    <div className="text-[10px] text-slate-400 text-center">※保存すると、上に表示されている開始日～終了日が日/期間へ反映されます</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 🔢 電卓ポップアップ画面 */}
      {keypadConfig.isOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 no-print">
          <div className="bg-white rounded-3xl border border-emerald-100 shadow-2xl w-full max-w-sm overflow-hidden transform scale-100 transition-all">
            
            <div className="bg-emerald-800 p-4 text-white">
              <div className="text-xs opacity-80">{keypadConfig.patientName}</div>
              <div className="text-base font-bold flex justify-between items-center mt-1">
                <span>{keypadConfig.label}</span>
                <button onClick={() => setKeypadConfig(prev => ({ ...prev, isOpen: false }))} className="text-xl font-normal hover:text-rose-200">✕</button>
              </div>
            </div>

            {(() => {
              const isAlert = checkFieldAlert(keypadConfig.field, keypadConfig.value);
              return (
                <div className={`p-4 border-b text-right transition-colors ${isAlert ? 'bg-rose-50 text-rose-600' : 'bg-slate-50 text-slate-800'}`}>
                  <div className="text-3xl font-mono font-bold tracking-wider min-h-[40px] relative">
                    {keypadConfig.value || <span className="text-slate-300 font-sans text-xl font-normal">数値をタップ</span>}
                    {isAlert && <span className="text-[10px] font-sans font-bold text-rose-500 absolute left-0 bottom-0">⚠️ 基準値外アラート</span>}
                  </div>
                </div>
              );
            })()}

            <div className="p-4 bg-slate-100/50 grid grid-cols-4 gap-2">
              {['7', '8', '9', '⌫', '4', '5', '6', 'C', '1', '2', '3', '/', '0', '.', '-'].map((btn) => {
                const isBpOnly = btn === '/' || btn === '-';
                if (isBpOnly && keypadConfig.field !== 'bp') {
                  return <div key={btn} className="bg-transparent" />;
                }

                let btnColor = 'bg-white active:bg-slate-200 text-slate-800 border-slate-200';
                if (btn === 'C' || btn === '0') btnColor = 'bg-rose-50 active:bg-rose-100 text-rose-600 border-rose-100';
                if (btn === '/' || btn === '-') btnColor = 'bg-amber-50 active:bg-amber-100 text-amber-700 border-amber-100';

                return (
                  <button
                    key={btn}
                    type="button"
                    onClick={() => handleKeypadPress(btn)}
                    className={`h-14 rounded-xl border text-lg font-bold font-mono shadow-xs flex items-center justify-center transition-all ${btnColor}`}
                  >
                    {btn}
                  </button>
                );
              })}

              <button
                type="button"
                onClick={saveKeypadValue}
                className="col-span-4 h-14 mt-2 bg-emerald-600 active:bg-emerald-700 text-white font-bold text-base rounded-xl shadow-md transition-all flex items-center justify-center"
              >
                <span>✅ この値で確定する</span>
              </button>
            </div>

          </div>
        </div>
      )}

      {/* 🔒 部屋図「意思決定・緊急時対応」レ点の一括編集モーダル（どれか1つのレ点をクリックすると表示）。
          現在部屋図に表示されている全入居者分をまとめて編集でき、保存時に1回だけ管理者パスワードを確認する */}
      {mapCheckboxEditorPatientId && (() => {
        const p = patients.find(pt => pt.id === mapCheckboxEditorPatientId);
        if (!p) return null;
        // 💾 修正せず開いただけならグレー、何か変更があれば緑にする
        const hasMapCheckboxChanges = MAP_CHECKBOX_FIELDS.some(f => p[f.key] !== mapCheckboxDraft[f.key]);
        return (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 no-print">
            <div className="bg-white rounded-3xl border border-purple-100 shadow-2xl w-full max-w-sm overflow-hidden">
              <div className="bg-purple-800 p-4 text-white flex justify-between items-center">
                <div>
                  <div className="text-xs opacity-80">🔒 意思決定・緊急時対応</div>
                  <div className={`text-base font-bold mt-0.5`}>{p.room}号室 {p.name}</div>
                </div>
                <button onClick={() => setMapCheckboxEditorPatientId(null)} className="text-2xl font-normal hover:text-rose-200">✕</button>
              </div>
              <div className="p-4">
                <div className="grid grid-cols-3 gap-x-3 gap-y-2 text-xs text-slate-700">
                  {MAP_CHECKBOX_FIELDS.map(f => (
                    <label key={f.key} className="flex items-center">
                      <input
                        type="checkbox"
                        checked={!!mapCheckboxDraft[f.key]}
                        onChange={() => setMapCheckboxDraft(prev => ({ ...prev, [f.key]: !prev[f.key] }))}
                        className="mr-1 scale-90"
                      />
                      {f.label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="p-4 border-t bg-slate-50 flex gap-2">
                <button onClick={() => setMapCheckboxEditorPatientId(null)} className="flex-1 bg-white text-slate-600 border border-slate-300 hover:bg-slate-50 font-bold px-4 py-2 rounded-xl">キャンセル</button>
                <button onClick={handleSaveMapCheckboxEditor} className={`flex-1 text-white font-bold px-4 py-2 rounded-xl shadow-md ${hasMapCheckboxChanges ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-slate-300'}`}>💾 保存</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 📎 部屋図の添付書類ビューア：サムネイルをダブルクリックすると表示 */}
      {viewingAttachedFile && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-xs flex items-center justify-center z-50 p-4 no-print" onClick={() => setViewingAttachedFile(null)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-3xl max-h-[90vh] w-full overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="bg-purple-800 p-3 text-white flex justify-between items-center shrink-0">
              <div className="text-sm font-bold truncate">📎 {viewingAttachedFile.name}</div>
              <button onClick={() => setViewingAttachedFile(null)} className="text-2xl font-normal hover:text-rose-200 shrink-0 ml-2">✕</button>
            </div>
            <div className="p-4 overflow-auto flex-1 flex items-center justify-center bg-slate-50">
              {viewingAttachedFile.type === 'image' && (
                <img src={viewingAttachedFile.dataUrl} alt={viewingAttachedFile.name} className="max-w-full max-h-[75vh] object-contain" />
              )}
              {viewingAttachedFile.type === 'video' && (
                <video src={viewingAttachedFile.dataUrl} controls className="max-w-full max-h-[75vh]" />
              )}
              {viewingAttachedFile.type === 'file' && (
                <div className="text-center text-sm text-slate-600 space-y-3">
                  <div className="text-4xl">📄</div>
                  <div>この形式はここでは表示できません。</div>
                  <a href={viewingAttachedFile.dataUrl} download={viewingAttachedFile.name} className="inline-block bg-purple-100 text-purple-800 px-4 py-2 rounded-xl font-bold border border-purple-300">
                    ダウンロードして開く
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 🏠 新規入居者登録モーダル（空室をクリックすると表示）。氏名欄はここでIME入力してもらうことで、
          緊急時対応サマリーシートの氏名編集と同じ仕組みでふりがなも同時に自動反映される */}
      {newPatientRoom && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 no-print">
          <div className="bg-white rounded-3xl border border-purple-100 shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="bg-purple-800 p-4 text-white flex justify-between items-center">
              <div>
                <div className="text-xs opacity-80">🏠 新規入居者登録</div>
                <div className="text-base font-bold mt-0.5">{newPatientRoom}号室</div>
              </div>
              <button onClick={handleCancelNewPatient} className="text-2xl font-normal hover:text-rose-200">✕</button>
            </div>
            <div className="p-4 space-y-3">
              {(() => {
                const [lastName, firstName] = splitFullName(newPatientDraft.name);
                const [lastNameKana, firstNameKana] = splitFullName(newPatientDraft.nameKana);
                const setLastName = (v: string) => setNewPatientDraft(prev => ({ ...prev, name: joinFullName(v, splitFullName(prev.name)[1]) }));
                const setFirstName = (v: string) => setNewPatientDraft(prev => ({ ...prev, name: joinFullName(splitFullName(prev.name)[0], v) }));
                const setLastNameKana = (v: string) => setNewPatientDraft(prev => ({ ...prev, nameKana: joinFullName(v, splitFullName(prev.nameKana)[1]) }));
                const setFirstNameKana = (v: string) => setNewPatientDraft(prev => ({ ...prev, nameKana: joinFullName(splitFullName(prev.nameKana)[0], v) }));
                return (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs font-bold text-slate-500">姓</label>
                        <input
                          type="text"
                          autoFocus
                          value={lastName}
                          autoComplete="off"
                          data-lpignore="true"
                          data-1p-ignore="true"
                          data-bwignore="true"
                          data-form-type="other"
                          onChange={e => setLastName(e.target.value)}
                          {...createNameKanaHandlers(() => splitFullName(newPatientDraft.name)[0], () => splitFullName(newPatientDraft.nameKana)[0], setLastNameKana)}
                          placeholder="例：鈴木"
                          className="w-full p-1.5 border rounded-lg mt-1"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-bold text-slate-500">名</label>
                        <input
                          type="text"
                          value={firstName}
                          autoComplete="off"
                          data-lpignore="true"
                          data-1p-ignore="true"
                          data-bwignore="true"
                          data-form-type="other"
                          onChange={e => setFirstName(e.target.value)}
                          {...createNameKanaHandlers(() => splitFullName(newPatientDraft.name)[1], () => splitFullName(newPatientDraft.nameKana)[1], setFirstNameKana)}
                          placeholder="例：一郎"
                          className="w-full p-1.5 border rounded-lg mt-1"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs font-bold text-slate-500">ふりがな（姓）</label>
                        <input
                          type="text"
                          value={lastNameKana}
                          onChange={e => setLastNameKana(e.target.value)}
                          placeholder="例：すずき"
                          className="w-full p-1.5 border rounded-lg mt-1"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-bold text-slate-500">ふりがな（名）</label>
                        <input
                          type="text"
                          value={firstNameKana}
                          onChange={e => setFirstNameKana(e.target.value)}
                          placeholder="例：いちろう"
                          className="w-full p-1.5 border rounded-lg mt-1"
                        />
                      </div>
                    </div>
                  </>
                );
              })()}
              <div>
                <label className="text-xs font-bold text-slate-500 block mb-1">性別</label>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setNewPatientDraft(prev => ({ ...prev, gender: 'male' }))}
                    className={`text-[10px] px-2 py-0.5 rounded-lg border font-bold ${newPatientDraft.gender === 'male' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-200'}`}
                  >
                    男性
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewPatientDraft(prev => ({ ...prev, gender: 'female' }))}
                    className={`text-[10px] px-2 py-0.5 rounded-lg border font-bold ${newPatientDraft.gender === 'female' ? 'bg-rose-600 text-white border-rose-600' : 'bg-white text-slate-500 border-slate-200'}`}
                  >
                    女性
                  </button>
                </div>
              </div>
            </div>
            <div className="p-4 border-t bg-slate-50 flex gap-2">
              <button onClick={handleCancelNewPatient} className="flex-1 bg-white text-slate-600 border border-slate-300 hover:bg-slate-50 font-bold px-4 py-2 rounded-xl">キャンセル</button>
              <button onClick={handleConfirmNewPatient} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-4 py-2 rounded-xl shadow-md">登録する</button>
            </div>
          </div>
        </div>
      )}

      {/* 🚨 緊急時対応サマリーシート モーダル（部屋をダブルクリックすると表示） */}
      {emergencyModalPatientId && summaryDraft && (() => {
        const p = patients.find(pt => pt.id === emergencyModalPatientId);
        if (!p) return null;
        const draft = summaryDraft;
        // 💾 修正せず開いただけならグレー、何か変更があれば緑にする（ageは生年月日から自動計算される
        //    値なので比較には含めない。含めると開いた瞬間の自動再計算だけで「変更あり」と誤判定するため。
        //    nameも下書き側は敬称を外した状態で持っているため、比較前に元のnameからも敬称を外す）
        const hasSummaryChanges = JSON.stringify({ name: stripHonorificSuffix(p.name), gender: p.gender, summary: p.emergencySummary }) !==
          JSON.stringify({ name: draft.name, gender: draft.gender, summary: draft.summary });

        return (
          <div className="modal-print-wrap fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
            <div className="modal-print-panel print-container bg-white border border-black shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">

              {/* ヘッダー */}
              <div className="bg-purple-800 p-4 text-white flex justify-between items-center shrink-0">
                <div>
                  <div className="text-xs opacity-80">🚨 緊急時対応サマリーシート</div>
                  <div className="text-base font-bold mt-0.5">{p.room}号室 {appendHonorificSuffix(draft.name)}<LastEditedHint p={p} /></div>
                  <div className="no-print text-[10px] opacity-70 mt-0.5">✏️ 編集中：保存ボタンを押すまで内容は反映されません</div>
                </div>
                <div className="flex items-center gap-2 no-print">
                  <button
                    type="button"
                    onClick={() => window.print()}
                    className="text-[11px] font-bold bg-white/15 hover:bg-white/25 border border-white/30 rounded-lg px-2.5 py-1.5 whitespace-nowrap"
                    title="この緊急時対応サマリーシートを印刷"
                  >
                    🖨️
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenTimeline(p.id)}
                    className="text-[11px] font-bold bg-white/15 hover:bg-white/25 border border-white/30 rounded-lg px-2.5 py-1.5 whitespace-nowrap"
                  >
                    📜 時系列を見る
                  </button>
                  <button onClick={handleCloseEmergencyModal} className="text-2xl font-normal hover:text-rose-200">✕</button>
                </div>
              </div>

              {/* 本体（スクロール可） */}
              <div className="modal-print-scroll overflow-y-auto p-4">
                <table className="w-full text-left text-xs border-collapse border border-black">
                  <thead className="bg-purple-50 text-purple-900 font-bold">
                    <tr>
                      <th className="p-2 border border-black w-32">項目</th>
                      <th className="p-2 border border-black">内容</th>
                      <th className="p-2 border border-black w-64">備考・詳細</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* 氏名・フリガナ・性別 */}
                    <tr>
                      <th className="p-2 border border-black bg-purple-50/50 align-top">氏名</th>
                      {(() => {
                        const [lastName, firstName] = splitFullName(draft.name);
                        const [lastNameKana, firstNameKana] = splitFullName(draft.summary.nameKana);
                        const setLastName = (v: string) => handleDraftFieldChange('name', joinFullName(v, splitFullName(draft.name)[1]));
                        const setFirstName = (v: string) => handleDraftFieldChange('name', joinFullName(splitFullName(draft.name)[0], v));
                        const setLastNameKana = (v: string) => handleDraftSummaryChange('nameKana', joinFullName(v, splitFullName(draft.summary.nameKana)[1]));
                        const setFirstNameKana = (v: string) => handleDraftSummaryChange('nameKana', joinFullName(splitFullName(draft.summary.nameKana)[0], v));
                        return (
                          <>
                            <td className="p-2 border border-black align-top">
                              <div className="grid grid-cols-2 gap-1">
                                <input
                                  type="text"
                                  value={lastName}
                                  // 🛡️ 氏名欄が空欄になった瞬間、ブラウザやパスワードマネージャー拡張機能（LastPass・1Password等）が
                                  //    候補アイコンをDOMへ直接差し込むことがあり、Reactが把握しているDOM構造とズレて
                                  //    「removeChild」エラーで画面全体がクラッシュする実例が確認されたため、
                                  //    これらの拡張機能に「この欄はオートフィル対象外」だと伝えて差し込みそのものを防ぐ
                                  autoComplete="off"
                                  data-lpignore="true"
                                  data-1p-ignore="true"
                                  data-bwignore="true"
                                  data-form-type="other"
                                  onChange={e => setLastName(e.target.value)}
                                  {...createNameKanaHandlers(() => splitFullName(draft.name)[0], () => splitFullName(draft.summary.nameKana)[0], setLastNameKana)}
                                  placeholder="姓（例：山田）"
                                  className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500"
                                />
                                <div className="flex items-center gap-1">
                                  <input
                                    type="text"
                                    value={firstName}
                                    autoComplete="off"
                                    data-lpignore="true"
                                    data-1p-ignore="true"
                                    data-bwignore="true"
                                    data-form-type="other"
                                    onChange={e => setFirstName(e.target.value)}
                                    {...createNameKanaHandlers(() => splitFullName(draft.name)[1], () => splitFullName(draft.summary.nameKana)[1], setFirstNameKana)}
                                    placeholder="名（例：太郎）"
                                    className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500"
                                  />
                                  <span className="shrink-0 text-xs font-bold text-slate-500">様</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 mt-1.5">
                                <select
                                  value={draft.gender}
                                  onChange={e => setSummaryDraft(prev => (prev ? { ...prev, gender: e.target.value as 'male' | 'female' } : prev))}
                                  className={`text-xs px-2 py-1 border-0 border-b border-slate-400 bg-transparent font-bold focus:outline-none focus:border-purple-500 ${draft.gender === 'female' ? 'text-rose-600' : 'text-slate-800'}`}
                                >
                                  <option value="male">男性</option>
                                  <option value="female">女性</option>
                                </select>
                              </div>
                            </td>
                            <td className="p-2 border border-black align-top">
                              <div className="grid grid-cols-2 gap-1">
                                <input type="text" value={lastNameKana} onChange={e => setLastNameKana(e.target.value)} placeholder="ふりがな（姓）例：やまだ" className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500" />
                                <input type="text" value={firstNameKana} onChange={e => setFirstNameKana(e.target.value)} placeholder="ふりがな（名）例：たろう" className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500" />
                              </div>
                            </td>
                          </>
                        );
                      })()}
                    </tr>

                    {/* 生年月日・年齢 */}
                    <tr>
                      <th className="p-2 border border-black bg-purple-50/50 align-top">年齢</th>
                      <td className="p-2 border border-black align-top">
                        {isBirthDateEditing ? (
                          <>
                            <div className="flex flex-wrap gap-1 mb-1.5">
                              {BIRTH_DATE_ERA_MODES.map(mode => (
                                <button
                                  key={mode}
                                  type="button"
                                  onClick={() => handleBirthDateEraModeChange(mode)}
                                  className={`text-[10px] px-2 py-0.5 rounded-lg border font-bold ${birthDateEraMode === mode ? 'bg-purple-700 text-white border-purple-700' : 'bg-white text-slate-500 border-slate-200'}`}
                                >
                                  {mode}
                                </button>
                              ))}
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[10px] text-slate-500">
                                生年月日（{birthDateEraMode === '西暦' ? '西暦8桁' : `${birthDateEraMode}○年○月○日`}で入力）：
                              </span>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={formatBirthDateDigitsForInput(birthDateRawInput, birthDateEraMode)}
                                onChange={e => handleBirthDateRawInputChange(e.target.value)}
                                placeholder={birthDateEraMode === '西暦' ? '例：19800808' : '例：160415'}
                                className="p-1 border-0 border-b border-slate-400 bg-transparent text-xs w-24 focus:outline-none focus:border-purple-500"
                              />
                            </div>
                          </>
                        ) : (
                          // 🗓️ 入力完了後は暦切り替えボタン・数字入力を畳み、和暦表記の確定表示だけにする
                          <div className="flex items-center gap-2">
                            <span className="font-bold">{formatISOToEraDate(draft.summary.birthDate)}</span>
                            <button
                              type="button"
                              onClick={() => setIsBirthDateEditing(true)}
                              className="text-[10px] px-2 py-0.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
                            >
                              変更
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="p-2 border border-black align-top">
                        {draft.age !== null ? (
                          <div className="flex items-center space-x-2">
                            <span>年齢：</span>
                            <span className="font-bold">{draft.age}</span>
                            <span>歳</span>
                          </div>
                        ) : (
                          <div className="text-[10px] text-slate-400">生年月日が未入力のため年齢は表示されません</div>
                        )}
                      </td>
                    </tr>

                    {/* キーパーソン */}
                    {draft.summary.keyPersons.map((kp, kpIdx) => (
                      <tr key={kp.id}>
                        <th className="p-2 border border-black bg-purple-50/50 align-top">キーパーソン{kpIdx === 0 ? '①' : '②'}</th>
                        <td className="p-2 border border-black align-top space-y-1">
                          <div className="flex space-x-1">
                            <input type="text" value={kp.name} onChange={e => handleDraftKeyPersonChange(kp.id, 'name', e.target.value)} placeholder="氏名" className="w-1/2 p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500" />
                            <input type="text" value={kp.relation} onChange={e => handleDraftKeyPersonChange(kp.id, 'relation', e.target.value)} placeholder="続柄（例：長女）" className="w-1/2 p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500" />
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              inputMode="numeric"
                              value={formatPostalCodeForInput(kp.postalCode)}
                              onChange={e => handleKeyPersonPostalCodeChange(kp.id, e.target.value)}
                              placeholder="郵便番号 例：1234567"
                              className="w-32 p-1.5 border-0 border-b border-slate-400 bg-transparent text-xs focus:outline-none focus:border-purple-500"
                            />
                            {postalLookupStatus[kp.id] === 'loading' && <span className="text-[10px] text-slate-400">検索中…</span>}
                            {postalLookupStatus[kp.id] === 'error' && <span className="text-[10px] text-rose-500">住所が見つかりませんでした</span>}
                          </div>
                          <input type="text" value={kp.address} onChange={e => handleDraftKeyPersonChange(kp.id, 'address', e.target.value)} placeholder="住所（郵便番号入力で市区町村まで自動入力）" className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500" />
                        </td>
                        <td className="p-2 border border-black align-top space-y-1">
                          <input type="text" value={kp.tel1} onChange={e => handleDraftKeyPersonChange(kp.id, 'tel1', e.target.value)} placeholder="①TEL：090-XXXX-XXXX" className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500" />
                          <input type="text" value={kp.tel2} onChange={e => handleDraftKeyPersonChange(kp.id, 'tel2', e.target.value)} placeholder="②携帯：03-XXXX-XXXX" className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500" />
                        </td>
                      </tr>
                    ))}

                    {/* かかりつけ医 */}
                    <tr>
                      <th className="p-2 border border-black bg-purple-50/50 align-top">かかりつけ医</th>
                      <td className="p-2 border border-black align-top space-y-1">
                        <div
                          className="relative"
                          onBlur={e => {
                            // 🈂️ 医院名⇔担当医の間でフォーカスが移っただけ（グループ内の移動）ならまだ編集中とみなし、
                            //    本当にグループの外へフォーカスが移った時だけ履歴に記録する（そうしないと、
                            //    片方だけ書き換えた直後にもう片方へ移った瞬間、書き換え前後が混ざった誤った
                            //    組み合わせが履歴に残ってしまう）
                            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                            handlePrimaryDoctorBlur();
                            setIsPrimaryDoctorHistoryOpen(false);
                          }}
                        >
                          <input
                            type="text"
                            value={draft.summary.primaryDoctorClinic}
                            onChange={e => handlePrimaryDoctorClinicChange(e.target.value)}
                            onFocus={() => setIsPrimaryDoctorHistoryOpen(true)}
                            placeholder="医院名（例：〇〇クリニック）"
                            title="クリックすると、これまでに入力したかかりつけ医の履歴から選べます"
                            className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500"
                          />
                          <input
                            type="text"
                            value={draft.summary.primaryDoctorName}
                            onChange={e => handleDraftSummaryChange('primaryDoctorName', e.target.value)}
                            onFocus={() => setIsPrimaryDoctorHistoryOpen(true)}
                            placeholder="担当医（例：佐藤 医師）"
                            title="クリックすると、これまでに入力したかかりつけ医の履歴から選べます"
                            className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500 mt-1"
                          />
                          <div className="flex items-center gap-2 mt-1">
                            <input
                              type="text"
                              inputMode="numeric"
                              value={formatPostalCodeForInput(draft.summary.primaryDoctorPostalCode)}
                              onChange={e => handlePrimaryDoctorPostalCodeChange(e.target.value)}
                              onFocus={() => setIsPrimaryDoctorHistoryOpen(true)}
                              placeholder="郵便番号 例：1234567"
                              className="w-32 p-1.5 border-0 border-b border-slate-400 bg-transparent text-xs focus:outline-none focus:border-purple-500"
                            />
                            {postalLookupStatus.primaryDoctor === 'loading' && <span className="text-[10px] text-slate-400">検索中…</span>}
                            {postalLookupStatus.primaryDoctor === 'error' && <span className="text-[10px] text-rose-500">住所が見つかりませんでした</span>}
                          </div>
                          <input
                            type="text"
                            value={draft.summary.primaryDoctorAddress}
                            onChange={e => handleDraftSummaryChange('primaryDoctorAddress', e.target.value)}
                            onFocus={() => setIsPrimaryDoctorHistoryOpen(true)}
                            placeholder="住所（郵便番号入力で市区町村まで自動入力）"
                            className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500 mt-1"
                          />
                          {isPrimaryDoctorHistoryOpen && (
                            <div className="absolute z-20 mt-1 bg-white border border-purple-200 rounded-lg shadow-lg w-full max-h-72 overflow-y-auto">
                              {sortByGuessedReading(primaryDoctorHistory, h => h.clinic || h.name).map(h => (
                                editingPrimaryDoctorHistoryId === h.id ? (
                                  <div key={h.id} className="p-2 border-b border-purple-100 space-y-1 bg-purple-50/50">
                                    <input type="text" value={primaryDoctorHistoryEditDraft.clinic} onChange={e => handleChangePrimaryDoctorHistoryEditDraft('clinic', e.target.value)} placeholder="医院名" className="w-full p-1 border rounded text-xs" />
                                    <input type="text" value={primaryDoctorHistoryEditDraft.name} onChange={e => handleChangePrimaryDoctorHistoryEditDraft('name', e.target.value)} placeholder="担当医" className="w-full p-1 border rounded text-xs" />
                                    <input type="text" inputMode="numeric" value={formatPostalCodeForInput(primaryDoctorHistoryEditDraft.postalCode)} onChange={e => handlePrimaryDoctorHistoryEditPostalCodeChange(e.target.value)} placeholder="郵便番号 例：1234567" className="w-full p-1 border rounded text-xs" />
                                    {postalLookupStatus.primaryDoctorHistoryEdit === 'loading' && <span className="text-[10px] text-slate-400">検索中…</span>}
                                    {postalLookupStatus.primaryDoctorHistoryEdit === 'error' && <span className="text-[10px] text-rose-500">住所が見つかりませんでした</span>}
                                    <input type="text" value={primaryDoctorHistoryEditDraft.address} onChange={e => handleChangePrimaryDoctorHistoryEditDraft('address', e.target.value)} placeholder="住所" className="w-full p-1 border rounded text-xs" />
                                    <input type="text" value={primaryDoctorHistoryEditDraft.tel} onChange={e => handleChangePrimaryDoctorHistoryEditDraft('tel', e.target.value)} placeholder="TEL" className="w-full p-1 border rounded text-xs" />
                                    <div className="flex justify-end gap-1">
                                      <button type="button" onMouseDown={e => e.preventDefault()} onClick={handleCancelEditPrimaryDoctorHistory} className="text-[10px] font-bold px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50">キャンセル</button>
                                      <button type="button" onMouseDown={e => e.preventDefault()} onClick={handleSaveEditPrimaryDoctorHistory} className="text-[10px] font-bold px-2 py-1 rounded border border-emerald-600 bg-emerald-600 hover:bg-emerald-700 text-white">💾 保存</button>
                                    </div>
                                  </div>
                                ) : (
                                  <div key={h.id} className="flex items-center hover:bg-purple-50">
                                    <button
                                      type="button"
                                      onMouseDown={e => e.preventDefault()}
                                      onClick={() => handleSelectPrimaryDoctorHistory(h)}
                                      className="flex-1 min-w-0 text-left px-3 py-1.5 text-xs text-slate-700"
                                    >
                                      {h.clinic}{h.clinic && h.name ? ' / ' : ''}{h.name}
                                      {h.tel ? ` / ${h.tel}` : ''}
                                      {h.address ? ` / ${h.address}` : ''}
                                    </button>
                                    <button
                                      type="button"
                                      onMouseDown={e => e.preventDefault()}
                                      onClick={() => handleStartEditPrimaryDoctorHistory(h)}
                                      className="shrink-0 text-slate-300 hover:text-purple-600 text-xs px-1.5"
                                      title="この履歴を修正"
                                    >
                                      ✏️
                                    </button>
                                    <button
                                      type="button"
                                      onMouseDown={e => e.preventDefault()}
                                      onClick={() => {
                                        if (window.confirm('この履歴を削除します。よろしいですか？')) handleDeletePrimaryDoctorHistory(h.id);
                                      }}
                                      className="shrink-0 text-slate-300 hover:text-rose-500 font-bold text-sm leading-none px-2"
                                      title="この履歴を削除"
                                    >
                                      ×
                                    </button>
                                  </div>
                                )
                              ))}
                              {/* ➕ メインの氏名欄を経由せず、その場で新しいかかりつけ医を登録する */}
                              <div className="p-2 border-t border-purple-200 space-y-1 bg-purple-50/30">
                                <div className="text-[10px] font-bold text-purple-700">＋ 新しいかかりつけ医を登録</div>
                                <input type="text" value={newPrimaryDoctorEntryDraft.clinic} onChange={e => handleChangeNewPrimaryDoctorEntryDraft('clinic', e.target.value)} placeholder="医院名" className="w-full p-1 border rounded text-xs" />
                                <input type="text" value={newPrimaryDoctorEntryDraft.name} onChange={e => handleChangeNewPrimaryDoctorEntryDraft('name', e.target.value)} placeholder="担当医" className="w-full p-1 border rounded text-xs" />
                                <input type="text" inputMode="numeric" value={formatPostalCodeForInput(newPrimaryDoctorEntryDraft.postalCode)} onChange={e => handleNewPrimaryDoctorEntryPostalCodeChange(e.target.value)} placeholder="郵便番号 例：1234567" className="w-full p-1 border rounded text-xs" />
                                {postalLookupStatus.newPrimaryDoctorEntry === 'loading' && <span className="text-[10px] text-slate-400">検索中…</span>}
                                {postalLookupStatus.newPrimaryDoctorEntry === 'error' && <span className="text-[10px] text-rose-500">住所が見つかりませんでした</span>}
                                <input type="text" value={newPrimaryDoctorEntryDraft.address} onChange={e => handleChangeNewPrimaryDoctorEntryDraft('address', e.target.value)} placeholder="住所" className="w-full p-1 border rounded text-xs" />
                                <input type="text" value={newPrimaryDoctorEntryDraft.tel} onChange={e => handleChangeNewPrimaryDoctorEntryDraft('tel', e.target.value)} placeholder="TEL" className="w-full p-1 border rounded text-xs" />
                                <button type="button" onMouseDown={e => e.preventDefault()} onClick={handleAddNewPrimaryDoctorHistoryEntry} className="w-full text-[10px] font-bold px-2 py-1 rounded border border-purple-300 bg-purple-100 hover:bg-purple-200 text-purple-800">＋ 追加</button>
                              </div>
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="p-2 border border-black align-top">
                        <input type="text" value={draft.summary.primaryDoctorTel} onChange={e => handleDraftSummaryChange('primaryDoctorTel', e.target.value)} placeholder="TEL：03-XXXX-XXXX" className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500" />
                      </td>
                    </tr>

                    {/* 救急搬送希望先 */}
                    <tr>
                      <th className="p-2 border border-black bg-purple-50/50 align-top">救急搬送希望先</th>
                      <td className="p-2 border border-black align-top space-y-1">
                        <div
                          className="relative"
                          onBlur={e => {
                            // 🈂️ ドロップダウン内の編集欄・追加欄へフォーカスが移っただけ（グループ内の移動）なら
                            //    まだ編集中とみなし、本当にグループの外へフォーカスが移った時だけ履歴に記録する
                            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                            handleEmergencyHospitalBlur();
                            setIsEmergencyHospitalHistoryOpen(false);
                          }}
                        >
                          <input
                            type="text"
                            value={draft.summary.emergencyHospitalName}
                            onChange={e => handleEmergencyHospitalNameChange(e.target.value)}
                            onFocus={() => setIsEmergencyHospitalHistoryOpen(true)}
                            placeholder="病院名（例：〇〇総合病院救急外来）"
                            title="クリックすると、これまでに入力した救急搬送希望先の履歴から選べます"
                            className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500"
                          />
                          {isEmergencyHospitalHistoryOpen && (
                            <div className="absolute z-20 mt-1 bg-white border border-purple-200 rounded-lg shadow-lg w-full max-h-72 overflow-y-auto">
                              {sortByGuessedReading(emergencyHospitalHistory, h => h.name).map(h => (
                                editingEmergencyHospitalHistoryId === h.id ? (
                                  <div key={h.id} className="p-2 border-b border-purple-100 space-y-1 bg-purple-50/50">
                                    <input type="text" value={emergencyHospitalHistoryEditDraft.name} onChange={e => handleChangeEmergencyHospitalHistoryEditDraft('name', e.target.value)} placeholder="病院名" className="w-full p-1 border rounded text-xs" />
                                    <input type="text" inputMode="numeric" value={formatPostalCodeForInput(emergencyHospitalHistoryEditDraft.postalCode)} onChange={e => handleEmergencyHospitalHistoryEditPostalCodeChange(e.target.value)} placeholder="郵便番号 例：1234567" className="w-full p-1 border rounded text-xs" />
                                    {postalLookupStatus.emergencyHospitalHistoryEdit === 'loading' && <span className="text-[10px] text-slate-400">検索中…</span>}
                                    {postalLookupStatus.emergencyHospitalHistoryEdit === 'error' && <span className="text-[10px] text-rose-500">住所が見つかりませんでした</span>}
                                    <input type="text" value={emergencyHospitalHistoryEditDraft.address} onChange={e => handleChangeEmergencyHospitalHistoryEditDraft('address', e.target.value)} placeholder="住所" className="w-full p-1 border rounded text-xs" />
                                    <input type="text" value={emergencyHospitalHistoryEditDraft.tel} onChange={e => handleChangeEmergencyHospitalHistoryEditDraft('tel', e.target.value)} placeholder="TEL" className="w-full p-1 border rounded text-xs" />
                                    <div className="flex justify-end gap-1">
                                      <button type="button" onMouseDown={e => e.preventDefault()} onClick={handleCancelEditEmergencyHospitalHistory} className="text-[10px] font-bold px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50">キャンセル</button>
                                      <button type="button" onMouseDown={e => e.preventDefault()} onClick={handleSaveEditEmergencyHospitalHistory} className="text-[10px] font-bold px-2 py-1 rounded border border-emerald-600 bg-emerald-600 hover:bg-emerald-700 text-white">💾 保存</button>
                                    </div>
                                  </div>
                                ) : (
                                  <div key={h.id} className="flex items-center hover:bg-purple-50">
                                    <button
                                      type="button"
                                      onMouseDown={e => e.preventDefault()}
                                      onClick={() => handleSelectEmergencyHospitalHistory(h)}
                                      className="flex-1 min-w-0 text-left px-3 py-1.5 text-xs text-slate-700"
                                    >
                                      {h.name}
                                      {h.tel ? ` / ${h.tel}` : ''}
                                      {h.address ? ` / ${h.address}` : ''}
                                    </button>
                                    <button
                                      type="button"
                                      onMouseDown={e => e.preventDefault()}
                                      onClick={() => handleStartEditEmergencyHospitalHistory(h)}
                                      className="shrink-0 text-slate-300 hover:text-purple-600 text-xs px-1.5"
                                      title="この履歴を修正"
                                    >
                                      ✏️
                                    </button>
                                    <button
                                      type="button"
                                      onMouseDown={e => e.preventDefault()}
                                      onClick={() => {
                                        if (window.confirm('この履歴を削除します。よろしいですか？')) handleDeleteEmergencyHospitalHistory(h.id);
                                      }}
                                      className="shrink-0 text-slate-300 hover:text-rose-500 font-bold text-sm leading-none px-2"
                                      title="この履歴を削除"
                                    >
                                      ×
                                    </button>
                                  </div>
                                )
                              ))}
                              {/* ➕ メインの病院名欄を経由せず、その場で新しい救急搬送希望先を登録する */}
                              <div className="p-2 border-t border-purple-200 space-y-1 bg-purple-50/30">
                                <div className="text-[10px] font-bold text-purple-700">＋ 新しい救急搬送希望先を登録</div>
                                <input type="text" value={newEmergencyHospitalEntryDraft.name} onChange={e => handleChangeNewEmergencyHospitalEntryDraft('name', e.target.value)} placeholder="病院名" className="w-full p-1 border rounded text-xs" />
                                <input type="text" inputMode="numeric" value={formatPostalCodeForInput(newEmergencyHospitalEntryDraft.postalCode)} onChange={e => handleNewEmergencyHospitalEntryPostalCodeChange(e.target.value)} placeholder="郵便番号 例：1234567" className="w-full p-1 border rounded text-xs" />
                                {postalLookupStatus.newEmergencyHospitalEntry === 'loading' && <span className="text-[10px] text-slate-400">検索中…</span>}
                                {postalLookupStatus.newEmergencyHospitalEntry === 'error' && <span className="text-[10px] text-rose-500">住所が見つかりませんでした</span>}
                                <input type="text" value={newEmergencyHospitalEntryDraft.address} onChange={e => handleChangeNewEmergencyHospitalEntryDraft('address', e.target.value)} placeholder="住所" className="w-full p-1 border rounded text-xs" />
                                <input type="text" value={newEmergencyHospitalEntryDraft.tel} onChange={e => handleChangeNewEmergencyHospitalEntryDraft('tel', e.target.value)} placeholder="TEL" className="w-full p-1 border rounded text-xs" />
                                <button type="button" onMouseDown={e => e.preventDefault()} onClick={handleAddNewEmergencyHospitalHistoryEntry} className="w-full text-[10px] font-bold px-2 py-1 rounded border border-purple-300 bg-purple-100 hover:bg-purple-200 text-purple-800">＋ 追加</button>
                              </div>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={formatPostalCodeForInput(draft.summary.emergencyHospitalPostalCode)}
                            onChange={e => handleEmergencyHospitalPostalCodeChange(e.target.value)}
                            placeholder="郵便番号 例：1234567"
                            className="w-32 p-1.5 border-0 border-b border-slate-400 bg-transparent text-xs focus:outline-none focus:border-purple-500"
                          />
                          {postalLookupStatus.emergencyHospital === 'loading' && <span className="text-[10px] text-slate-400">検索中…</span>}
                          {postalLookupStatus.emergencyHospital === 'error' && <span className="text-[10px] text-rose-500">住所が見つかりませんでした</span>}
                        </div>
                        <input type="text" value={draft.summary.emergencyHospitalAddress} onChange={e => handleDraftSummaryChange('emergencyHospitalAddress', e.target.value)} placeholder="住所（郵便番号入力で市区町村まで自動入力）" className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500" />
                      </td>
                      <td className="p-2 border border-black align-top">
                        <input type="text" value={draft.summary.emergencyHospitalTel} onChange={e => handleDraftSummaryChange('emergencyHospitalTel', e.target.value)} placeholder="TEL：03-YYYY-YYYY" className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500" />
                      </td>
                    </tr>

                    {/* 主な疾患名 */}
                    <tr>
                      <th className="p-2 border border-black bg-purple-50/50 align-top">主な疾患名</th>
                      <td className="p-2 border border-black align-top" colSpan={2}>
                        <textarea value={draft.summary.mainDiseasesText} onChange={e => handleDraftSummaryChange('mainDiseasesText', e.target.value)} rows={2} placeholder="例：脳梗塞後遺症、高血圧症、慢性心不全" className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500" />
                      </td>
                    </tr>

                    {/* 内服薬 */}
                    <tr>
                      <th className="p-2 border border-black bg-purple-50/50 align-top">内服薬</th>
                      <td className="p-2 border border-black align-top" colSpan={2}>
                        <div className="space-y-1">
                          {draft.summary.medications.map((m, mIdx) => (
                            <div key={m.id} className="flex items-center space-x-1">
                              <span className="text-slate-400 w-4">{mIdx + 1}</span>
                              <div className="relative flex-1">
                                <input
                                  type="text"
                                  value={m.name}
                                  onChange={e => handleDraftMedicationChange(m.id, 'name', e.target.value)}
                                  onFocus={() => setOpenMedicationHistoryId(m.id)}
                                  onBlur={() => { handleMedicationNameBlur(m.id); setOpenMedicationHistoryId(prev => prev === m.id ? null : prev); }}
                                  placeholder="薬剤名（例：アスピリン腸溶錠 100mg）"
                                  title="クリックすると、これまでに入力した内服薬の履歴から選べます"
                                  className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500"
                                />
                                {openMedicationHistoryId === m.id && (() => {
                                  // 💊 すでに他の行で選択・入力済みの薬剤名は、追加でクリックした時の一覧に出さない
                                  const usedNames = new Set(
                                    draft.summary.medications.filter(x => x.id !== m.id && x.name.trim()).map(x => x.name.trim())
                                  );
                                  const availableHistory = sortJaAsc(medicationHistory.filter(h => !usedNames.has(h.name)), h => h.name);
                                  if (availableHistory.length === 0) return null;
                                  return (
                                    <div className="absolute z-20 mt-1 bg-white border border-purple-200 rounded-lg shadow-lg w-full max-h-48 overflow-y-auto">
                                      {availableHistory.map((h, i) => (
                                        <div key={`${h.name}_${h.dosageTiming}_${i}`} className="flex items-center hover:bg-purple-50">
                                          <button
                                            type="button"
                                            onMouseDown={e => e.preventDefault()}
                                            onClick={() => handleSelectMedicationHistory(m.id, h)}
                                            className="flex-1 min-w-0 text-left px-3 py-1.5 text-xs text-slate-700"
                                          >
                                            {h.name}{h.name && h.dosageTiming ? ' / ' : ''}{h.dosageTiming}
                                          </button>
                                          <button
                                            type="button"
                                            onMouseDown={e => e.preventDefault()}
                                            onClick={() => {
                                              if (window.confirm('この履歴を削除します。よろしいですか？')) handleDeleteMedicationHistory(h);
                                            }}
                                            className="shrink-0 text-slate-300 hover:text-rose-500 font-bold text-sm leading-none px-2"
                                            title="この履歴を削除"
                                          >
                                            ×
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  );
                                })()}
                              </div>
                              <input type="text" value={m.dosageTiming} onChange={e => handleDraftMedicationChange(m.id, 'dosageTiming', e.target.value)} placeholder="用法（例：朝食後 1錠）" className="w-40 p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500" />
                              <button type="button" onClick={() => handleDraftRemoveMedication(m.id)} className="no-print text-slate-300 hover:text-rose-500 font-bold px-1" title="この薬を削除">×</button>
                            </div>
                          ))}
                          <button type="button" onClick={handleDraftAddMedication} className="no-print text-[10px] text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-lg px-2 py-1 font-bold">＋ 追加</button>
                        </div>
                        <input type="text" value={draft.summary.medicationNotebookLocation} onChange={e => handleDraftSummaryChange('medicationNotebookLocation', e.target.value)} placeholder="内服薬・お薬手帳の保管場所" className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500 mt-2" />
                      </td>
                    </tr>

                    {/* アレルギー */}
                    <tr>
                      <th className="p-2 border border-black bg-purple-50/50 align-top">アレルギー</th>
                      <td className="p-2 border border-black align-top">
                        <textarea value={draft.summary.allergyText} onChange={e => handleDraftSummaryChange('allergyText', e.target.value)} rows={2} placeholder="例：食物：なし" className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500" />
                      </td>
                      <td className="p-2 border border-black align-top">
                        <div className="space-y-1">
                          {draft.summary.contraindicatedMedications.map((cm, cmIdx) => (
                            <div key={cm.id} className="flex items-center space-x-1">
                              <span className="text-slate-400 w-4">{cmIdx + 1}</span>
                              <div className="relative flex-1">
                                <input
                                  type="text"
                                  value={cm.name}
                                  onChange={e => handleDraftContraindicatedMedicationChange(cm.id, e.target.value)}
                                  onFocus={() => setOpenContraindicatedHistoryId(cm.id)}
                                  onBlur={() => { handleContraindicatedNameBlur(cm.id); setOpenContraindicatedHistoryId(prev => prev === cm.id ? null : prev); }}
                                  placeholder="禁忌薬"
                                  title="クリックすると、これまでに入力した禁忌薬の履歴から選べます"
                                  className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500"
                                />
                                {openContraindicatedHistoryId === cm.id && (() => {
                                  // 💊 すでに他の行で選択・入力済みの禁忌薬名は、追加でクリックした時の一覧に出さない
                                  const usedNames = new Set(
                                    draft.summary.contraindicatedMedications.filter(x => x.id !== cm.id && x.name.trim()).map(x => x.name.trim())
                                  );
                                  const availableHistory = sortJaAsc(contraindicatedMedicationHistory.filter(h => !usedNames.has(h)), h => h);
                                  if (availableHistory.length === 0) return null;
                                  return (
                                    <div className="absolute z-20 mt-1 bg-white border border-purple-200 rounded-lg shadow-lg w-full max-h-48 overflow-y-auto">
                                      {availableHistory.map((h, i) => (
                                        <div key={`${h}_${i}`} className="flex items-center hover:bg-purple-50">
                                          <button
                                            type="button"
                                            onMouseDown={e => e.preventDefault()}
                                            onClick={() => handleSelectContraindicatedHistory(cm.id, h)}
                                            className="flex-1 min-w-0 text-left px-3 py-1.5 text-xs text-slate-700"
                                          >
                                            {h}
                                          </button>
                                          <button
                                            type="button"
                                            onMouseDown={e => e.preventDefault()}
                                            onClick={() => {
                                              if (window.confirm('この履歴を削除します。よろしいですか？')) handleDeleteContraindicatedHistory(h);
                                            }}
                                            className="shrink-0 text-slate-300 hover:text-rose-500 font-bold text-sm leading-none px-2"
                                            title="この履歴を削除"
                                          >
                                            ×
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  );
                                })()}
                              </div>
                              <button type="button" onClick={() => handleDraftRemoveContraindicatedMedication(cm.id)} className="no-print text-slate-300 hover:text-rose-500 font-bold px-1" title="この薬を削除">×</button>
                            </div>
                          ))}
                          <button type="button" onClick={handleDraftAddContraindicatedMedication} className="no-print text-[10px] text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-lg px-2 py-1 font-bold">＋ 追加</button>
                        </div>
                      </td>
                    </tr>

                    {/* 感染症有無 */}
                    <tr>
                      <th className="p-2 border border-black bg-purple-50/50 align-top">感染症有無</th>
                      <td className="p-2 border border-black align-top">
                        <div className="space-y-1">
                          {draft.summary.infectionStatusItems.map((it, itIdx) => (
                            <div key={it.id} className="flex items-center space-x-1">
                              <span className="text-slate-400 w-4">{itIdx + 1}</span>
                              <div className="relative flex-1">
                                <input
                                  type="text"
                                  value={it.text}
                                  onChange={e => handleDraftInfectionItemChange(it.id, e.target.value)}
                                  onFocus={() => setOpenInfectionHistoryId(it.id)}
                                  onBlur={() => { handleInfectionItemBlur(it.id); setOpenInfectionHistoryId(prev => prev === it.id ? null : prev); }}
                                  placeholder="例：HCV"
                                  title="クリックすると、これまでに入力した感染症有無の履歴から選べます"
                                  className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500"
                                />
                                {openInfectionHistoryId === it.id && (() => {
                                  // 🦠 すでに他の行で選択・入力済みの項目は、追加でクリックした時の一覧に出さない
                                  const usedTexts = new Set(
                                    draft.summary.infectionStatusItems.filter(x => x.id !== it.id && x.text.trim()).map(x => x.text.trim())
                                  );
                                  const availableHistory = sortJaAsc(infectionStatusHistory.filter(h => !usedTexts.has(h)), h => h);
                                  if (availableHistory.length === 0) return null;
                                  return (
                                    <div className="absolute z-20 mt-1 bg-white border border-purple-200 rounded-lg shadow-lg w-full max-h-48 overflow-y-auto">
                                      {availableHistory.map((h, i) => (
                                        <div key={`${h}_${i}`} className="flex items-center hover:bg-purple-50">
                                          <button
                                            type="button"
                                            onMouseDown={e => e.preventDefault()}
                                            onClick={() => handleSelectInfectionHistory(it.id, h)}
                                            className="flex-1 min-w-0 text-left px-3 py-1.5 text-xs text-slate-700"
                                          >
                                            {h}
                                          </button>
                                          <button
                                            type="button"
                                            onMouseDown={e => e.preventDefault()}
                                            onClick={() => {
                                              if (window.confirm('この履歴を削除します。よろしいですか？')) handleDeleteInfectionHistory(h);
                                            }}
                                            className="shrink-0 text-slate-300 hover:text-rose-500 font-bold text-sm leading-none px-2"
                                            title="この履歴を削除"
                                          >
                                            ×
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  );
                                })()}
                              </div>
                              <button type="button" onClick={() => handleDraftRemoveInfectionItem(it.id)} className="no-print text-slate-300 hover:text-rose-500 font-bold px-1" title="この項目を削除">×</button>
                            </div>
                          ))}
                          <button type="button" onClick={handleDraftAddInfectionItem} className="no-print text-[10px] text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-lg px-2 py-1 font-bold">＋ 追加</button>
                        </div>
                      </td>
                      <td className="p-2 border border-black align-top">
                        <div className="flex items-center space-x-1">
                          <span className="text-[10px] text-slate-500 whitespace-nowrap">最終検査日：</span>
                          <input type="text" value={draft.summary.lastTestDate} onChange={e => handleDraftSummaryChange('lastTestDate', e.target.value)} placeholder="202X年〇月〇日" className="w-full p-1.5 border-0 border-b border-slate-400 bg-transparent focus:outline-none focus:border-purple-500" />
                          <button
                            type="button"
                            onClick={openLastTestDateCalendar}
                            className="no-print shrink-0 text-base leading-none px-1.5 py-1.5 rounded-lg border border-purple-200 bg-purple-50 hover:bg-purple-100"
                            title="カレンダーから日付を選択"
                          >
                            🗓️
                          </button>
                        </div>
                      </td>
                    </tr>

                    {/* 最終更新日・更新者（保存すると自動記録／編集不可） */}
                    <tr>
                      <th className="p-2 border border-black bg-purple-50/50 align-top">最終更新日 / 更新者</th>
                      <td className="p-2 border border-black align-top bg-slate-50" colSpan={2}>
                        <div className="text-xs space-y-0.5">
                          <div>📅 最終更新日：<span className="font-bold">{p.emergencySummary.lastUpdated || '未記録'}</span></div>
                          <div>👤 更新者：<span className="font-bold">{p.emergencySummary.updatedBy || '未記録'}</span></div>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* フッター：保存 / キャンセル */}
              <div className="no-print p-3 border-t border-black flex justify-end gap-2 shrink-0">
                <button onClick={handleCloseEmergencyModal} className="bg-white text-slate-600 border border-slate-300 hover:bg-slate-50 font-bold px-6 py-2 rounded-xl">キャンセル（保存しない）</button>
                <button onClick={handleSaveEmergencySummary} className={`text-white font-bold px-6 py-2 rounded-xl shadow-md ${hasSummaryChanges ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-slate-300'}`}>💾 保存</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 📦 物品管理：定数を変更した時の「変更しますね」お知らせ。他の場所をクリックすると（変更を受け入れて）閉じるが、
          「キャンセル」を押すとその場で元の数へ取り消せる */}
      {supplyChangeToast && (
        <div
          style={{ top: supplyChangeToast.top, left: supplyChangeToast.left }}
          className="no-print fixed -translate-x-1/2 z-[70] bg-slate-800 text-white text-sm font-bold pl-4 pr-2 py-2 rounded-xl shadow-lg flex items-center gap-3 whitespace-nowrap"
        >
          変更しますね
          <button
            type="button"
            onClick={handleCancelSupplyAllocatedChange}
            className="text-xs font-bold bg-white/15 hover:bg-white/25 border border-white/30 rounded-lg px-3 py-1.5"
          >
            キャンセル
          </button>
        </div>
      )}

    </div>
  );
}