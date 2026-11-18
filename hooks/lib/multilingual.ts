// Task vocabulary beyond English and German, for the most common languages
// of Claude Code users: Spanish, French, Portuguese, Italian, Dutch, Polish,
// Russian, Chinese, Japanese and Korean.
//
// Latin-script words are written as `fold` leaves them (lower case, accents
// removed: "análisis" is "analisis", "łatwy" is "latwy") and use word
// boundaries. Cyrillic, CJK and Hangul are matched as substrings: JavaScript's
// `\b` only knows ASCII word characters, and Chinese and Japanese put no
// spaces between words.
//
// Languages not listed here still get the language-neutral signals (code
// blocks, stack traces, file references, numbered steps, length); an unclear
// prompt falls back to the session's level, and the optional AI
// classification covers any language.

import type { Category } from './classifier'

const L = (latin: string, other = ''): RegExp =>
  new RegExp(`\\b(${latin})\\b${other ? `|${other}` : ''}`)

const G = (latin: string, other = ''): RegExp =>
  new RegExp(`\\b(${latin})\\b${other ? `|${other}` : ''}`, 'g')

/** Extra patterns per task type; the base patterns stay in classifier.ts. */
export const MULTI_CATEGORY: Partial<Record<Category, RegExp>> = {
  // Question words count only as the opening (after an optional greeting).
  question: new RegExp(
    '^(\\S+[,!]?\\s+)?(que|como|por que|porque|cual|cuales|cuando|donde|o que|qual|quando|onde|come|perche|cosa|quale|dove|comment|pourquoi|quoi|quel|quelle|quels|est-ce que|hoe|wat|waarom|welke|wanneer|waar|jak|co|dlaczego|ktory|ktora|kiedy|gdzie)\\b' +
      '|^(\\S+[,!]?\\s+)?(как|что|почему|зачем|какой|какая|когда|где|чем)(\\s|$)' +
      '|什么|怎么|如何|为什么|吗[?]?$|呢[?]?$|とは|ですか|ますか|なぜ|どうやって|どのように|무엇|어떻게|왜|인가요|나요[?]?$|까요[?]?$',
  ),
  trivial_edit: L(
    'renombra\\w*|cambia el nombre|renomme\\w*|renomeie|renomear|rinomina\\w*|hernoem\\w*|zmien nazwe|error tipografico|faute de frappe|errore di battitura|literowk\\w*',
    'переименуй|переименовать|опечатк|重命名|改名|错别字|拼写错误|名前を変更|名前を変え|リネーム|誤字|タイポ|이름을? 바꿔|이름 변경|오타',
  ),
  routine: L(
    'commit\\w*|push\\w*|pull|haz commit|fais un commit|faca commit|ejecuta (las |los )?(pruebas|tests)|lance (les )?tests|execute (os )?testes|esegui (i )?test|voer (de )?tests uit|uruchom testy|instala (las )?dependencias|installe (les )?dependances|instale (as )?dependencias|installa (le )?dipendenze|installeer (de )?afhankelijkheden|zainstaluj zaleznosci|compila (el |o |il )?(proyecto|projeto|progetto)|compile le projet',
    'коммит|закоммит|запуш|пушни|запусти тесты|установи зависимости|собери проект|提交|推送|拉取|运行测试|安装依赖|构建项目|コミット|プッシュ|プル|テストを実行|依存関係をインストール|ビルドして|커밋|푸시|테스트 실행|의존성 설치|빌드해',
  ),
  content: L(
    'lista|listas|liste|listes|elenco|lijst|resume|resumen|resumo|resuma|resumir|riassumi|riassunto|samenvatting|vat samen|podsumuj|traduce|traduis|traduza|traduci|vertaal|przetlumacz|ideas|idees|ideias|idee|ideeen|pomysly|borrador|brouillon|rascunho|bozza|lluvia de ideas',
    'список|кратко|резюме|переведи|идеи|列表|清单|总结|摘要|翻译|头脑风暴|リスト|一覧|要約|翻訳|アイデア|目록|목록|리스트|요약|번역|아이디어',
  ),
  implement: L(
    'implementa|implementar|implemente|implementez|implementeer|zaimplementuj|anade|agrega|ajoute|ajouter|adicione|aggiungi|voeg|dodaj|crea una? (\\w+ ){0,2}(funcion|clase|componente|aplicacion|api)|cree une? (\\w+ ){0,2}(fonction|classe|application)|crie uma? (\\w+ ){0,2}(funcao|classe|aplicacao)|crea una? (\\w+ ){0,2}(funzione|classe|applicazione)|maak een (\\w+ ){0,2}(functie|klasse)|utworz|nueva funcion|nouvelle fonction|nova funcao|nuova funzione',
    'реализуй|реализовать|добавь|создай|напиши (функци|класс|скрипт)|新功能|实现|添加|新增|编写|実装|追加して|新機能|구현|추가해|새 기능|만들어 ?줘',
  ),
  modify: L(
    'modifica|modifie|modifique|cambia|change|altere|actualiza|mets a jour|atualize|aggiorna|wijzig|zmien|zaktualizuj|ajusta|ajuste',
    'измени|обнови|修改|更新|调整|変更して|更新して|수정해|변경|업데이트',
  ),
  tests: L(
    'pruebas unitarias|tests unitarios|tests unitaires|ecris des tests|testes unitarios|test unitari|unit tests schrijven|testy jednostkowe',
    'юнит-?тест|напиши тесты|单元测试|测试用例|写测试|テストを書|単体テスト|テストコード|단위 테스트|테스트 (작성|코드)',
  ),
  debug: L(
    'error|errores|fallo|falla|arregla|corrige|corrija|depura|depurar|no funciona|erreur|erreurs|bug|bugs|debogue|plante|ne fonctionne pas|ne marche pas|erro|erros|conserte|depure|nao funciona|errore|errori|correggi|risolvi|non funziona|si blocca|fout|fouten|repareer|werkt niet|crasht|blad|bledy|napraw|nie dziala',
    'ошибк|баг|исправь|почини|не работает|падает|вылетает|错误|报错|修复|调试|崩溃|不工作|异常|エラー|バグ|デバッグ|動かない|クラッシュ|直して|오류|에러|버그|디버그|작동하지|고쳐',
  ),
  perf: L(
    'rendimiento|lento|lenta|optimiza|optimise|optimiser|desempenho|otimize|prestazioni|ottimizza|prestaties|traag|optimaliseer|wydajnosc|zoptymalizuj|fuga de memoria|fuite de memoire|vazamento de memoria',
    'производительн|медленн|оптимизир|утечк|性能|太慢|优化|内存泄漏|パフォーマンス|遅い|最適化|メモリリーク|성능|느려|최적화|메모리 누수',
  ),
  analysis: L(
    'analiza|analizar|analisis|revisa|evalua|investiga|analyse|analyser|examine|evalue|analise|avalie|investigue|analizza|valuta|rivedi|analyseer|beoordeel|onderzoek|przeanalizuj|ocen|zbadaj|przejrzyj',
    'проанализируй|анализ|оцени|исследуй|分析|审查|评估|调查|レビュー|評価|調査|분석|검토|평가|조사|리뷰',
  ),
  refactor_arch: L(
    'refactoriza\\w*|refactorizacion|refactoring|arquitectura|reestructura\\w*|migra|migracion|refactorise\\w*|architecture|restructure\\w*|migre|migration|refatore|refatoracao|arquitetura|reestruture|migracao|rifattorizza\\w*|architettura|ristruttura\\w*|migrazione|architectuur|herstructureer|migreer|refaktoryzuj|refaktoryzacja|architektur\\w*|zmigruj|migracja',
    'рефактор|архитектур|реструктур|миграц|перепиши|重构|架构|迁移|重写|リファクタ|アーキテクチャ|移行|書き直|리팩터|리팩토링|아키텍처|마이그레이션|재작성',
  ),
  security: L(
    'seguridad|vulnerabilidad\\w*|securite|vulnerabilite\\w*|faille\\w*|seguranca|vulnerabilidade\\w*|sicurezza|vulnerabilita|beveiliging|kwetsbaarhe\\w*|bezpieczenstw\\w*|podatnosc\\w*',
    'безопасност|уязвимост|安全|漏洞|セキュリティ|脆弱性|보안|취약점',
  ),
  math: L(
    'demuestra|demostracion|teorema|matematic\\w*|ecuacion\\w*|probabilidad|demontre|preuve|theoreme|mathematique\\w*|equation\\w*|probabilite|demonstre|prova|equacao|probabilidade|dimostra|equazione|probabilita|bewijs|stelling|wiskund\\w*|vergelijking|udowodnij|twierdzen\\w*|matematy\\w*|rownani\\w*',
    'докажи|доказательств|теорем|математич|уравнени|вероятност|证明|定理|数学|方程|概率|証明|方程式|確率|증명|정리|수학|방정식|확률',
  ),
}

/** Extra modifier patterns, counted like the base ones. */
export const MULTI_BOOST = {
  difficulty: G(
    'dificil|dificiles|complejo|compleja|complicado|complicada|sutil|intermitente|a fondo|exhaustiv\\w*|difficile|complexe|complique\\w*|subtil\\w*|intermittent\\w*|en profondeur|approfondi\\w*|complexo|complexa|aprofundad\\w*|complesso|complessa|complicato|sottile|approfondit\\w*|moeilijk|ingewikkeld|subtiel|diepgaand|trudn\\w*|zlozon\\w*|skomplikowan\\w*|doglebn\\w*',
    'сложн|трудн|запутан|глубок|тщательн|плавающ|困难|复杂|棘手|难以复现|很难|深入|彻底|難しい|複雑|再現しにくい|徹底|어려운|어렵|복잡|재현하기 어려|깊이|철저',
  ),
  simple: G(
    'simple|sencillo|sencilla|facil|rapido|rapida|facile|rapide|simples|semplice|veloce|simpel|eenvoudig|makkelijk|prosty|prosta|latwy|latwa',
    'прост|легк|简单|容易|簡単|간단|쉬운',
  ),
  smallScope: G(
    'pequeno|pequena|pequenas|petit|petite|pequeno|pequena|piccolo|piccola|klein|kleine|maly|mala|solo esta|seulement cette',
    'небольш|маленьк|小的|小型|一个小|小さな|小さい|작은',
  ),
  scope: G(
    'tod[oa] (el |la |mi |su |nuestro )?(proyecto|codigo|aplicacion|repositorio|sistema)|todos los archivos|varios archivos|extens\\w*|tout (le |mon |notre )?(projet|code)|toute (l.|mon |notre )?(application|base de code)|tous les fichiers|plusieurs fichiers|vaste|todo o (meu )?(projeto|codigo)|todos os arquivos|varios arquivos|(tutto|intero) (il |mio )?(progetto|codice)|tutti i file|piu file|hele (project|codebase)|alle bestanden|meerdere bestanden|uitgebreid\\w*|caly projekt|wszystkie pliki|wiele plikow|obszern\\w*',
    'вс(его|ь|ём|ем) (моего |нашего )?(проект|код)|все файлы|несколько файлов|масштабн|整个项目|所有文件|多个文件|大规模|全面|プロジェクト全体|全ファイル|複数のファイル|大規模|전체 프로젝트|모든 파일|여러 파일|대규모',
  ),
  risk: G(
    'produccion|perdida de datos|efectos secundarios|existente|base de codigo existente|perte de donnees|effets de bord|existant\\w*|producao|perda de dados|efeitos colaterais|produzione|perdita di dati|effetti collaterali|esistente|productie|dataverlies|bijwerkingen|bestaande|produkcj\\w*|utrata danych|efekty uboczne|istniejac\\w*',
    'продакшн|продакшен|потер. данных|побочн|существующ|生产环境|线上|数据丢失|副作用|现有|既存|本番|データ損失|프로덕션|운영 환경|데이터 손실|부작용|기존',
  ),
  correctness: G(
    'critico|critica|preciso|precisa|critique|precis|precise|exacte|critici|corretto|kritiek|precies|krytyczn\\w*|dokladn\\w*',
    'критичн|точност|корректн|关键|严格|精确|正确性|厳密|正確|중요한|엄밀|정확',
  ),
  autonomy: G(
    'planifica|planea|de principio a fin|paso a paso|y luego|planifie|de bout en bout|etape par etape|puis|planeje|passo a passo|e depois|pianifica|passo dopo passo|e poi|stap voor stap|en dan|zaplanuj|krok po kroku|a potem|de forma autonoma|de maniere autonome|autonomamente',
    'спланируй|составь план|пошагов|затем|самостоятельно|规划|计划|一步一步|然后|自主|計画|段階的|その後|自律|계획|단계별|그 다음|자율',
  ),
  ambiguity: G(
    'varias opciones|compara|alternativas?|estrategia|plusieurs options|alternatives?|strategie|varias opcoes|compare|confronta|alternativ\\w*|vergelijk|porownaj|strategi\\w*',
    'сравни|альтернатив|стратеги|несколько вариант|比较|权衡|方案|策略|比較|選択肢|戦略|トレードオフ|비교|대안|전략|장단점',
  ),
  verification: G(
    'pruebas|verifica|asegurate|casos limite|teste|testes|verifie|assure-toi|cas limites|verifique|garanta|casos extremos|assicurati|casi limite|controleer|zorg dat|randgevallen|przetestuj|sprawdz|upewnij sie|przypadki brzegowe',
    'протестируй|тест|проверь|убедись|граничн|测试|验证|确保|边界情况|テスト|検証|境界|테스트|검증|엣지 케이스',
  ),
}

/** Short follow-ups in these languages ("sí, sigue", "继续"). */
export const MULTI_CONTINUATION =
  /^((si|vale|sigue|continua|adelante|dale|oui|vas-y|continue|sim|pode|prosseguir|prosegui|vai|ja|ga door|doe maar|tak|dalej|kontynuuj|ok|okay|da|давай|продолжай|продолжи|да|ок|好|好的|继续|可以|行|はい|続けて|お願いします|進めて|네|계속|좋아요?|진행해)[\s!.,。！、]*){1,3}$/
