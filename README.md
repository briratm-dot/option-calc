# הסתברות הגעה למחיר יעד · First Passage Time (GBM) · נתונים חיים מ-FMP

כלי אינטראקטיבי לחישוב הסתברות שמניה **תיגע** במחיר יעד (touch) או **תסגור מעליו** (finish)
לפי אופקי זמן, על בסיס תנועה בראונית גאומטרית, עם שתי הנחות דריפט במקביל
(Risk-Neutral מול Physical). הנתונים נמשכים חיים מ-FMP — אפשר להחליף סימבול ולטעון מחדש.

## ארכיטקטורה (מאובטחת)

```
דפדפן (React)  →  /api/stock  (פונקציית serverless, מחזיקה את המפתח)  →  FMP /stable
```

**מפתח ה-FMP אף פעם לא נחשף בדפדפן.** הוא יושב רק כ-environment variable בצד השרת.

```
api/stock.js     הפונקציה ה-serverless: מקבלת ?symbol=, קוראת ל-FMP, מחשבת σ/μ/תשואות, מחזירה JSON נקי
src/App.jsx      הממשק + מנוע ה-First Passage Time + הגרפים
src/main.jsx     נקודת כניסה
index.html       מעטפת HTML (RTL)
```

## פריסה ל-Vercel (מומלץ — אתר שנפתח מכל מחשב)

1. צור מפתח חינמי ב-FMP: https://site.financialmodelingprep.com/developer/docs
2. העלה את התיקייה הזו ל-GitHub (או גרור אותה ב-`vercel` CLI).
3. ב-Vercel: **New Project → Import** את הריפו. ה-framework יזוהה אוטומטית כ-Vite.
4. ב-**Settings → Environment Variables** הוסף:
   ```
   FMP_API_KEY = <המפתח שלך>
   ```
5. **Deploy**. תקבל כתובת `https://<שם>.vercel.app` שנפתחת מכל מחשב.

> חלופה: Netlify. הפונקציה תעבוד עם התאמה קלה — העבר את `api/stock.js`
> ל-`netlify/functions/stock.js` והגדר redirect מ-`/api/stock` ל-`/.netlify/functions/stock`.

## הרצה מקומית

```bash
npm install
echo "FMP_API_KEY=המפתח_שלך" > .env.local
npx vercel dev        # מריץ את ה-frontend + הפונקציה /api יחד
```

(אם תריץ `npm run dev` לבד — ה-UI יעלה אבל קריאות `/api/stock` ייכשלו, כי אין backend.
לפיתוח מלא מקומי השתמש ב-`vercel dev`.)

## הערה מתמטית (drift convention) — מתוקן

המודל מחשב `ν = μ − σ²/2` ומזין אותו לנוסחת ה-First Passage. ה-`μ` שמוחזר
מ-FMP הוא ה**דריפט הארית'** של ה-GBM: `μ = (mean של log-returns × 252) + σ²/2`.
כך `ν = μ − σ²/2` משחזר **במדויק** את הדריפט הלוגריתמי האמפירי, בלי להוריד σ²/2
פעמיים, ובאופן סימטרי לצד הריסק-נייטרלי שבו `ν_RN = r − σ²/2` (r הוא דריפט ארית').

## IV (אופציונלי)

שדה "IV גלום" ריק כברירת מחדל. כשממלאים בו את ה-IV מהברוקר (מתוך שרשרת
האופציות), נוספות עמודות **Touch · IV / Finish · IV** וקו בגרף — הסתברות תחת
drift ריסק-נייטרלי עם σ = IV. זו ההסתברות שמשתמעת ממחיר האופציה בפועל; הפער
מול עמודות ה-RN (σ היסטורי) הוא אפקט ה-σ הטהור.

## תזכורת
- σ דומיננטי הרבה יותר מ-μ. למסחר אופציות השווה את σ ההיסטורי ל-**IV** הגלום.
- כל מודל הוא הפשטה; תוצאות עבר אינן מבטיחות עתיד. אין כאן ייעוץ השקעות.
