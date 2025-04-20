require('dotenv').config();
const express = require('express');
const cors = require('cors');
const generateRoute = require('./routes/generate');



const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', generateRoute);


const port = process.env.PORT || 5001;

app.use(router); // Your routes

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
