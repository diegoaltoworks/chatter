This is the command to flatten the repo,

```
rm -rf .git
git init
git config user.name "Diego ALTO"
git config user.email  "diego@diegoalto.co.uk"
git config user.signingkey "EA56157C3F4E64EA"
git config commit.gpgsign true
git add .
git remote add origin git@github.com:diegoaltoworks/chatter.git
git commit -m "Initial release: Chatter"
git push --set-upstream origin main -f
```