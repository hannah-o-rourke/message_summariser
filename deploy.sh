git pull
npm i
npm run build
cp catchup.json ../tool-hub/registrations/catchup.json
pm2 restart catchup
