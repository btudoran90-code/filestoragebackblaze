# filestoragebackblaze

Depozitul de fișiere pe care îl folosesc sesiunile Claude Code: rapoarte, capturi,
arhive, orice descarcă sau produce Claude și merită păstrat după ce sesiunea se
închide (containerul e efemer, bucket-ul nu).

`store.mjs` e un client S3 **fără nicio dependență** — doar `node`, fără
`npm install`. Semnează cererile cu AWS SigV4 peste `fetch`, deci merge la fel
din sesiunile cloud, de pe laptop și de pe orice mașină cu Node 18+.

Provider: **Backblaze B2** (10 GB gratuit permanent, egress gratuit până la 3x
stocarea medie, fără card la înscriere). Același script merge cu Cloudflare R2,
AWS S3 sau MinIO — se schimbă doar `S3_ENDPOINT`.

## Configurare

Variabilele sunt setate în **claude.ai → environment settings**. Nu se pun în
acest repo: cheia e un secret.

| Variabilă | Exemplu | Obligatorie |
|---|---|---|
| `S3_ENDPOINT` | `https://s3.eu-central-003.backblazeb2.com` | da |
| `S3_ACCESS_KEY_ID` | keyID din Backblaze | da |
| `S3_SECRET_ACCESS_KEY` | applicationKey din Backblaze | da |
| `S3_BUCKET` | numele bucket-ului | da, dacă nu e `claude-downloads` |
| `S3_REGION` | dedusă din endpoint | nu |
| `S3_PUBLIC_URL` | adresa publică a bucket-ului | doar pentru `url --public` |

Regiunea de semnare e dedusă din endpoint pentru Backblaze și AWS, deci nu
trebuie setată manual. Pentru R2 se folosește `auto`.

Cheia trebuie restricționată la un singur bucket, cu drept *Read and Write*.
Așa, o cheie scăpată nu ajunge la restul contului.

### Cont nou, de la zero

1. Cont pe [Backblaze](https://www.backblaze.com/sign-up/cloud-storage).
2. **B2 Cloud Storage → Buckets → Create a Bucket**, tip *Private*, cu
   *Default Encryption* activată. Numele e **unic global**, deci `claude-downloads`
   simplu e de obicei ocupat — pune un sufix.
3. **Application Keys → Add a New Application Key**, *Read and Write*,
   restricționat la acel bucket. `applicationKey` se afișează **o singură dată**.
4. Endpoint-ul apare pe pagina bucket-ului, de forma `s3.<regiune>.backblazeb2.com`.

## Comenzi

```bash
node store.mjs ls [prefix]                # listează obiectele (recursiv), cu mărime și dată
node store.mjs put raport.pdf reports/    # urcă; o cheie terminată în "/" păstrează numele fișierului
node store.mjs get reports/raport.pdf     # descarcă în directorul curent
node store.mjs cat notes/todo.md          # afișează un obiect text
node store.mjs head reports/raport.pdf    # mărime, content-type, last-modified
node store.mjs rm reports/raport.pdf      # șterge (definitiv, fără versionare)
node store.mjs url reports/raport.pdf 86400   # link presemnat, valabil 24h (max 7 zile)
node store.mjs url --public reports/raport.pdf
node store.mjs mb                         # creează bucket-ul, o singură dată
node store.mjs buckets                    # ce bucket-uri vede cheia
```

O cheie restricționată la un bucket nu poate lista bucket-urile contului. E
comportamentul dorit, iar `buckets` spune asta în loc să dea eroare.

## Folosire dintr-o altă sesiune Claude Code

Repo-ul e public, deci scriptul se ia cu o singură comandă, fără să atașezi
repo-ul și fără token:

```bash
curl -sSL -o store.mjs https://raw.githubusercontent.com/btudoran90-code/filestoragebackblaze/main/store.mjs
node store.mjs ls
```

Cheile rămân în environment settings, private. Public e doar codul, care nu
conține niciun secret — doar semnare S3 standard.

Alternativ, dacă lucrezi mai mult în repo, atașează-l la sesiune și rulează
`node /home/user/filestoragebackblaze/store.mjs`. Așa se încarcă și `CLAUDE.md`,
deci sesiunea știe singură convențiile de mai jos.

## Convenții

Cheile se grupează pe prefixe, după scop: `downloads/`, `reports/`,
`screenshots/`, `kodinoo/`. Numele original al fișierului se păstrează. O cheie
existentă nu se suprascrie fără să ceară utilizatorul. Când utilizatorul vrea un
fișier, i se dă un link cu `url`, nu conținutul lipit în chat.

## Testare locală

Scriptul merge cu orice server compatibil S3:

```bash
S3_ENDPOINT=http://127.0.0.1:9000 \
S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... S3_BUCKET=test \
node store.mjs ls
```
