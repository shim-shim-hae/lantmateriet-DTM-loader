# Bounding box DTM downloader for the Swedish DTM
This app downloads the bounding box DTM for the Swedish DTM. The app takes a bounding box as input and returns the DTM data for that area.

## Swedish Lantmäteriet API for DTM data
The app uses the Swedish Lantmäteriet API to download the DTM data.

The API is a STAC API available at the following URL:  
https://api.lantmateriet.se/stac-hojd/v1/

API documentation can be found at the following URL:  
https://api.lantmateriet.se/stac-hojd/v1/api.html

## Environment
The app is built using Node.js and uses the 'axios' library to make HTTP requests to the API. The app also uses the 'fs' library to save the downloaded DTM tiles to the user's computer. The app can be run in a terminal or command prompt.

## Input
Input to the app is a bounding box defined by the coordinates of the lower left and upper right corners. The coordinates should be in the format: "min_lon,min_lat,max_lon,max_lat". WGS84 coordinate system is used (EPSG:4326).
For example (in JSON): {"bbox": [17.9, 59.2, 18.2, 59.5]}

## API response
The API response is a JSON listing 'collections' of DTM tiles that contain the bounding box and 'assets', i.e. the actual DTM tiles within the bounding box.
The download URL is under feature.assets.data.href in the API response.

## Output
The app returns a list of download URLs for the DTM tiles that intersect with the input bounding box. The output is in JSON format, for example:

{  
    "dtm_tiles":  
    [  
    "https://dl1.lantmateriet.se/hojd/data/grid1m/65_6/55/65875_6750_25.tif",  
    "https://dl1.lantmateriet.se/hojd/data/grid1m/65_6/55/65875_6750_26.tif"
    ]  
}  

Then the app asks the user if they want to download the DTM tiles. If the user confirms, the app will download the DTM tiles and save them to a specified directory on the user's computer. The app will also return the file paths of the downloaded DTM tiles in JSON format, for example:

{  
  "downloaded_tiles":  
  [  
    "/path/to/downloaded/65875_6750_25.tif",  
    "/path/to/downloaded/65875_6750_26.tif"  
  ]  
}